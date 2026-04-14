import { retryWithBackoff, type Logger } from "@valiq-trading/core"

export type TokenProvider = () => Promise<string>

export interface ValiqClientConfig {
    apiUrl: string
    tokenProvider: TokenProvider
    timeout?: number
    logger?: Logger
}

export class ValiqClient {
    private config: ValiqClientConfig
    private logger?: Logger

    constructor(config: ValiqClientConfig) {
        this.config = config
        this.logger = config.logger
    }

    private async resolveToken(): Promise<string> {
        return this.config.tokenProvider()
    }

    async request<T>(path: string, options?: RequestInit): Promise<T> {
        const url = `${this.config.apiUrl}${path}`
        this.logger?.debug("ValiqClient request", { method: options?.method ?? "GET", path })

        const token = await this.resolveToken()

        const doFetch = async () => {
            const response = await retryWithBackoff(
                () =>
                    fetch(url, {
                        ...options,
                        headers: {
                            Authorization: `Bearer ${token}`,
                            "Content-Type": "application/json",
                            ...options?.headers,
                        },
                        signal: AbortSignal.timeout(this.config.timeout ?? 30_000),
                    }),
                3,
                1000
            )
            return response
        }

        let response = await doFetch()

        if (response.status === 401) {
            this.logger?.debug("ValiqClient got 401, refreshing token", { path })
            const freshToken = await this.resolveToken()
            response = await retryWithBackoff(
                () =>
                    fetch(url, {
                        ...options,
                        headers: {
                            Authorization: `Bearer ${freshToken}`,
                            "Content-Type": "application/json",
                            ...options?.headers,
                        },
                        signal: AbortSignal.timeout(this.config.timeout ?? 30_000),
                    }),
                3,
                1000
            )
        }

        if (!response.ok) {
            const body = await response.text().catch(() => "")
            this.logger?.error("ValiqClient request failed", {
                path,
                status: response.status,
                body: body.slice(0, 500),
            })
            throw new Error(`Val-iQ API error: ${response.status} ${response.statusText}`)
        }

        const result = (await response.json()) as T
        this.logger?.debug("ValiqClient response ok", { path })
        return result
    }

    async requestSSE(
        path: string,
        body: Record<string, unknown>,
        options?: { timeout?: number }
    ): Promise<ReadableStream<Uint8Array>> {
        const url = `${this.config.apiUrl}${path}`
        const timeout = options?.timeout ?? 120_000
        this.logger?.debug("ValiqClient SSE request", { path })

        const token = await this.resolveToken()

        const response = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                Accept: "text/event-stream",
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeout),
        })

        if (!response.ok) {
            const text = await response.text().catch(() => "")
            this.logger?.error("ValiqClient SSE request failed", {
                path,
                status: response.status,
                body: text.slice(0, 500),
            })
            throw new Error(`Val-iQ SSE error: ${response.status} ${response.statusText}`)
        }

        if (!response.body) {
            throw new Error("Val-iQ SSE response has no body")
        }

        return response.body
    }
}

export interface ValiqDataClientConfig {
    apiUrl: string
    apiKey: string
    timeout?: number
    logger?: Logger
}

export class ValiqDataApiError extends Error {
    readonly status?: number
    readonly code: string
    readonly retryable: boolean
    readonly details: Record<string, unknown>

    constructor(
        message: string,
        options: {
            status?: number
            code: string
            retryable: boolean
            details?: Record<string, unknown>
        }
    ) {
        super(message)
        this.name = "ValiqDataApiError"
        this.status = options.status
        this.code = options.code
        this.retryable = options.retryable
        this.details = options.details ?? {}
    }
}

export class ValiqDataClient {
    private config: ValiqDataClientConfig
    private logger?: Logger

    constructor(config: ValiqDataClientConfig) {
        this.config = config
        this.logger = config.logger
    }

    async request<T>(path: string, options?: RequestInit): Promise<T> {
        const url = `${this.config.apiUrl}${path}`
        const method = options?.method ?? "GET"
        const timeoutMs = this.config.timeout ?? 25_000
        const attempts = resolveValiqDataRetryAttempts(timeoutMs)
        const startedAt = performance.now()
        this.logger?.debug("ValiqDataClient request", { method, path, timeoutMs, attempts })

        const requestInit = {
            ...options,
            headers: {
                "X-API-Key": this.config.apiKey,
                "Content-Type": "application/json",
                ...options?.headers,
            },
            signal: AbortSignal.timeout(timeoutMs),
        }

        let response: Response
        let attempt = 0
        try {
            response = await fetchWithBoundedRetry(
                url,
                requestInit,
                attempts,
                500,
                (metadata) => {
                    attempt = metadata.attempt
                    this.logger?.warn("ValiqDataClient transport retry", {
                        method,
                        path,
                        timeoutMs,
                        attempt: metadata.attempt,
                        attempts,
                        durationMs: Math.round(performance.now() - startedAt),
                        error: metadata.error,
                    })
                }
            )
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            const timedOut = isTimeoutLikeError(error)
            const durationMs = Math.round(performance.now() - startedAt)
            this.logger?.error("ValiqDataClient transport failed", {
                method,
                path,
                timeoutMs,
                attempts,
                attempt: attempt || 1,
                durationMs,
                error: message,
                timedOut,
            })
            throw new ValiqDataApiError(`Val-iQ Data API transport error: ${message}`, {
                code: timedOut ? "UPSTREAM_TIMEOUT" : "TRANSPORT_ERROR",
                retryable: !timedOut,
                details: {
                    method,
                    path,
                    timeoutMs,
                    attempts,
                    attempt: attempt || 1,
                    durationMs,
                },
            })
        }

        if (!response.ok) {
            const body = await response.text().catch(() => "")
            this.logger?.error("ValiqDataClient request failed", {
                path,
                status: response.status,
                body: body.slice(0, 500),
            })
            throw new ValiqDataApiError(`Val-iQ Data API error: ${response.status} ${response.statusText}`, {
                status: response.status,
                code: response.status === 401 || response.status === 403
                    ? "AUTH_FAILED"
                    : response.status === 400
                        ? "BAD_PARAMS"
                        : response.status === 404
                            ? "EMPTY_DATA"
                            : response.status === 408 || response.status === 504
                                ? "UPSTREAM_TIMEOUT"
                                : "UPSTREAM_ERROR",
                retryable: response.status >= 500 || response.status === 408 || response.status === 429,
                details: {
                    method,
                    path,
                    body: body.slice(0, 1000),
                    durationMs: Math.round(performance.now() - startedAt),
                },
            })
        }

        try {
            const result = (await response.json()) as T
            this.logger?.debug("ValiqDataClient response ok", {
                method,
                path,
                durationMs: Math.round(performance.now() - startedAt),
            })
            return result
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            throw new ValiqDataApiError(`Val-iQ Data API returned invalid JSON: ${message}`, {
                status: response.status,
                code: "INVALID_JSON",
                retryable: false,
                details: {
                    method,
                    path,
                    durationMs: Math.round(performance.now() - startedAt),
                },
            })
        }
    }
}

async function fetchWithBoundedRetry(
    url: string,
    init: RequestInit,
    attempts: number,
    baseDelayMs: number,
    onRetry: (metadata: { attempt: number; error: string }) => void
): Promise<Response> {
    let attempt = 0

    while (attempt < attempts) {
        attempt++
        try {
            return await fetch(url, init)
        } catch (error) {
            if (isTimeoutLikeError(error) || attempt >= attempts) {
                throw error
            }

            const message = error instanceof Error ? error.message : String(error)
            onRetry({ attempt, error: message })
            await delay(baseDelayMs * 2 ** (attempt - 1))
        }
    }

    throw new Error("Val-iQ Data API retry loop exited without a response")
}

function isTimeoutLikeError(error: unknown): boolean {
    if (!(error instanceof Error)) return false

    const name = error.name.toLowerCase()
    const message = error.message.toLowerCase()
    return name.includes("abort")
        || name.includes("timeout")
        || message.includes("abort")
        || message.includes("timeout")
        || message.includes("timed out")
}

async function delay(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms))
}

function resolveValiqDataRetryAttempts(timeoutMs: number): number {
    if (timeoutMs >= 60_000) {
        return 1
    }

    if (timeoutMs >= 30_000) {
        return 2
    }

    return 3
}

export function createStaticTokenProvider(token: string): TokenProvider {
    return async () => token
}

export interface OAuthTokenProviderConfig {
    authUrl: string
    clientId: string
    clientSecret: string
    userUuid: string
    logger?: Logger
}

export function createOAuthTokenProvider(config: OAuthTokenProviderConfig): TokenProvider {
    let cachedToken: string | null = null
    let expiresAt = 0

    return async () => {
        const now = Date.now()
        if (cachedToken && now < expiresAt) {
            return cachedToken
        }

        config.logger?.debug("ValiqOAuth acquiring token", { authUrl: config.authUrl })

        const response = await fetch(`${config.authUrl}/oauth/token`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                client_id: config.clientId,
                client_secret: config.clientSecret,
                grant_type: "client_credentials",
                uuid: config.userUuid,
            }),
            signal: AbortSignal.timeout(15_000),
        })

        if (!response.ok) {
            const body = await response.json().catch(() => ({})) as {
                error?: string
                error_description?: string
            }
            const errorCode = body.error ?? "unknown"
            const errorDesc = body.error_description ?? `HTTP ${response.status}`
            config.logger?.error("ValiqOAuth token acquisition failed", {
                error: errorCode,
                description: errorDesc,
            })
            throw new Error(`Val-iQ OAuth error: ${errorCode} - ${errorDesc}`)
        }

        const data = await response.json() as {
            access_token: string
            token_type: string
            expires_in: number
        }

        cachedToken = data.access_token
        expiresAt = now + (data.expires_in - 30) * 1000

        config.logger?.debug("ValiqOAuth token acquired", {
            expiresIn: data.expires_in,
        })

        return cachedToken
    }
}

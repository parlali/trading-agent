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

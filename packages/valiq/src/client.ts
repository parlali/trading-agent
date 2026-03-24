import { retryWithBackoff, type Logger } from "@valiq-trading/core"

export interface ValiqClientConfig {
    apiUrl: string
    authToken: string
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

    async request<T>(path: string, options?: RequestInit): Promise<T> {
        const url = `${this.config.apiUrl}${path}`
        this.logger?.debug("ValiqClient request", { method: options?.method ?? "GET", path })

        const response = await retryWithBackoff(
            () =>
                fetch(url, {
                    ...options,
                    headers: {
                        Authorization: `Bearer ${this.config.authToken}`,
                        "Content-Type": "application/json",
                        ...options?.headers,
                    },
                    signal: AbortSignal.timeout(this.config.timeout ?? 30_000),
                }),
            3,
            1000
        )

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

        const response = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${this.config.authToken}`,
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

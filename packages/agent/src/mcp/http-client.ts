import type { Logger } from "@valiq-trading/core"

export interface HttpMcpClientConfig {
    id: string
    url: string
    token?: string
    timeoutMs?: number
    protocolVersion?: string
    logger?: Pick<Logger, "debug" | "warn" | "error">
}

export interface HttpMcpTool {
    name: string
    description?: string
    inputSchema?: Record<string, unknown>
}

interface JsonRpcSuccess<T> {
    jsonrpc: "2.0"
    id: string | number
    result: T
}

interface JsonRpcFailure {
    jsonrpc: "2.0"
    id: string | number | null
    error: {
        code: number
        message: string
        data?: unknown
    }
}

interface ToolsListResult {
    tools?: HttpMcpTool[]
    nextCursor?: string
}

export interface ToolsCallResult {
    content?: Array<Record<string, unknown>>
    structuredContent?: unknown
    isError?: boolean
    [key: string]: unknown
}

export class HttpMcpClient {
    private requestId = 0
    private initialized = false
    private sessionId: string | undefined

    constructor(private readonly config: HttpMcpClientConfig) {}

    async listTools(signal?: AbortSignal): Promise<HttpMcpTool[]> {
        await this.initialize(signal)

        const tools: HttpMcpTool[] = []
        let cursor: string | undefined

        do {
            const result = await this.request<ToolsListResult>("tools/list", cursor ? { cursor } : {}, signal)
            tools.push(...(result.tools ?? []))
            cursor = typeof result.nextCursor === "string" && result.nextCursor.length > 0
                ? result.nextCursor
                : undefined
        } while (cursor)

        this.config.logger?.debug("MCP tools listed", {
            providerId: this.config.id,
            toolCount: tools.length,
        })

        return tools
    }

    async callTool(
        name: string,
        args: unknown,
        signal?: AbortSignal
    ): Promise<ToolsCallResult> {
        await this.initialize(signal)
        return await this.request<ToolsCallResult>("tools/call", {
            name,
            arguments: args,
        }, signal)
    }

    private async initialize(signal?: AbortSignal): Promise<void> {
        if (this.initialized) {
            return
        }

        await this.request("initialize", {
            protocolVersion: this.config.protocolVersion ?? "2025-03-26",
            capabilities: {},
            clientInfo: {
                name: "trading-agent",
                version: "1.0.0",
            },
        }, signal)
        await this.notify("notifications/initialized", signal)
        this.initialized = true
    }

    private async notify(method: string, signal?: AbortSignal): Promise<void> {
        try {
            await this.post({
                jsonrpc: "2.0",
                method,
                params: {},
            }, signal)
        } catch (error) {
            this.config.logger?.warn("MCP notification failed", {
                providerId: this.config.id,
                method,
                error: error instanceof Error ? error.message : String(error),
            })
        }
    }

    private async request<T>(
        method: string,
        params: Record<string, unknown>,
        signal?: AbortSignal
    ): Promise<T> {
        const id = ++this.requestId
        const payload = await this.post({
            jsonrpc: "2.0",
            id,
            method,
            params,
        }, signal)

        if (!isJsonRpcResponse(payload)) {
            throw new Error(`MCP provider ${this.config.id} returned a non-JSON-RPC response for ${method}`)
        }

        if ("error" in payload) {
            throw new Error(`MCP provider ${this.config.id} ${method} failed: ${payload.error.message}`)
        }

        return payload.result as T
    }

    private async post(payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 30_000)
        const abortFromParent = () => controller.abort(signal?.reason)
        signal?.addEventListener("abort", abortFromParent, { once: true })

        try {
            const response = await fetch(this.config.url, {
                method: "POST",
                headers: this.createHeaders(),
                body: JSON.stringify(payload),
                signal: controller.signal,
            })

            this.captureSessionId(response)
            const text = await response.text()
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`)
            }

            if (text.trim().length === 0) {
                return null
            }

            return parseMcpResponseBody(text, response.headers.get("content-type")) as unknown
        } catch (error) {
            this.config.logger?.error("MCP HTTP request failed", {
                providerId: this.config.id,
                error: error instanceof Error ? error.message : String(error),
            })
            throw error
        } finally {
            clearTimeout(timeout)
            signal?.removeEventListener("abort", abortFromParent)
        }
    }

    private createHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": this.config.protocolVersion ?? "2025-03-26",
        }

        if (this.config.token) {
            headers.Authorization = `Bearer ${this.config.token}`
        }

        if (this.sessionId) {
            headers["Mcp-Session-Id"] = this.sessionId
        }

        return headers
    }

    private captureSessionId(response: Response): void {
        const sessionId = response.headers.get("mcp-session-id")
        if (sessionId && sessionId.trim().length > 0) {
            this.sessionId = sessionId.trim()
        }
    }
}

function parseMcpResponseBody(text: string, contentType: string | null): unknown {
    if (contentType?.includes("text/event-stream")) {
        const data = text
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .find((line) => line.length > 0 && line !== "[DONE]")

        if (!data) {
            throw new Error("MCP event-stream response did not include a JSON data event")
        }

        return JSON.parse(data) as unknown
    }

    return JSON.parse(text) as unknown
}

function isJsonRpcResponse(value: unknown): value is JsonRpcSuccess<unknown> | JsonRpcFailure {
    if (!value || typeof value !== "object") {
        return false
    }

    const record = value as Record<string, unknown>
    return record.jsonrpc === "2.0" &&
        ("result" in record || "error" in record)
}

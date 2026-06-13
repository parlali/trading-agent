import type { Logger } from "@valiq-trading/core"

export interface HttpMcpClientConfig {
    id: string
    url: string
    token?: string
    timeoutMs?: number
    protocolVersion?: string
    maxListPages?: number
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

export interface ListToolsOptions {
    signal?: AbortSignal
    maxTools?: number
    maxPages?: number
}

const DEFAULT_MAX_LIST_PAGES = 10

export class HttpMcpClient {
    private requestId = 0
    private initialized = false
    private sessionId: string | undefined

    constructor(private readonly config: HttpMcpClientConfig) {}

    async listTools(options: ListToolsOptions = {}): Promise<HttpMcpTool[]> {
        await this.initialize(options.signal)

        const tools: HttpMcpTool[] = []
        let cursor: string | undefined
        const seenCursors = new Set<string>()
        const maxPages = options.maxPages ?? this.config.maxListPages ?? DEFAULT_MAX_LIST_PAGES
        let page = 0

        do {
            page++
            if (page > maxPages) {
                throw new Error(`MCP provider ${this.config.id} tools/list exceeded max page count ${maxPages}`)
            }

            if (cursor) {
                if (seenCursors.has(cursor)) {
                    throw new Error(`MCP provider ${this.config.id} tools/list returned repeated cursor ${cursor}`)
                }
                seenCursors.add(cursor)
            }

            const result = validateToolsListResult(
                this.config.id,
                await this.request<unknown>("tools/list", cursor ? { cursor } : {}, options.signal)
            )
            tools.push(...result.tools)
            if (options.maxTools !== undefined && tools.length > options.maxTools) {
                throw new Error(`MCP provider ${this.config.id} exposed more than configured maxTools ${options.maxTools}`)
            }
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
        return validateToolsCallResult(this.config.id, name, await this.request<unknown>("tools/call", {
            name,
            arguments: args,
        }, signal))
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
        }, signal, id)

        if (!isJsonRpcResponse(payload)) {
            throw new Error(`MCP provider ${this.config.id} returned a non-JSON-RPC response for ${method}`)
        }

        if ("error" in payload) {
            throw new Error(`MCP provider ${this.config.id} ${method} failed: ${payload.error.message}`)
        }

        return payload.result as T
    }

    private async post(
        payload: Record<string, unknown>,
        signal?: AbortSignal,
        expectedId?: string | number
    ): Promise<unknown> {
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

            return parseMcpResponseBody(text, response.headers.get("content-type"), expectedId) as unknown
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

function parseMcpResponseBody(
    text: string,
    contentType: string | null,
    expectedId?: string | number
): unknown {
    if (contentType?.includes("text/event-stream")) {
        const matches = parseServerSentEventData(text)
            .filter((data) => data.length > 0 && data !== "[DONE]")
            .map((data) => JSON.parse(data) as unknown)
            .filter((value) => isJsonRpcResponse(value))

        const match = expectedId === undefined
            ? matches[0]
            : matches.find((value) => value.id === expectedId)

        if (!match) {
            throw new Error("MCP event-stream response did not include a matching JSON-RPC response")
        }

        return match
    }

    const parsed = JSON.parse(text) as unknown
    if (expectedId === undefined || !isJsonRpcResponse(parsed) || parsed.id === expectedId) {
        return parsed
    }

    throw new Error("MCP JSON response id did not match request id")
}

function parseServerSentEventData(text: string): string[] {
    const events: string[] = []
    let dataLines: string[] = []

    for (const line of text.split(/\r?\n/)) {
        if (line.length === 0) {
            if (dataLines.length > 0) {
                events.push(dataLines.join("\n").trim())
                dataLines = []
            }
            continue
        }

        if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart())
        }
    }

    if (dataLines.length > 0) {
        events.push(dataLines.join("\n").trim())
    }

    return events
}

function isJsonRpcResponse(value: unknown): value is JsonRpcSuccess<unknown> | JsonRpcFailure {
    if (!value || typeof value !== "object") {
        return false
    }

    const record = value as Record<string, unknown>
    return record.jsonrpc === "2.0" &&
        ("result" in record || "error" in record)
}

function validateToolsListResult(providerId: string, value: unknown): { tools: HttpMcpTool[], nextCursor?: string } {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`MCP provider ${providerId} returned malformed tools/list result`)
    }

    const record = value as Record<string, unknown>
    const rawTools = record.tools
    if (rawTools !== undefined && !Array.isArray(rawTools)) {
        throw new Error(`MCP provider ${providerId} returned malformed tools/list tools`)
    }

    const tools = (rawTools ?? []).map((tool, index) => validateMcpTool(providerId, tool, index))
    const nextCursor = typeof record.nextCursor === "string" && record.nextCursor.length > 0
        ? record.nextCursor
        : undefined

    return {
        tools,
        nextCursor,
    }
}

function validateMcpTool(providerId: string, value: unknown, index: number): HttpMcpTool {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`MCP provider ${providerId} returned malformed tool at index ${index}`)
    }

    const record = value as Record<string, unknown>
    if (typeof record.name !== "string" || record.name.trim().length === 0) {
        throw new Error(`MCP provider ${providerId} returned tool without a valid name at index ${index}`)
    }

    if (record.description !== undefined && typeof record.description !== "string") {
        throw new Error(`MCP provider ${providerId} returned tool ${record.name} with malformed description`)
    }

    if (record.inputSchema !== undefined && (!record.inputSchema || typeof record.inputSchema !== "object" || Array.isArray(record.inputSchema))) {
        throw new Error(`MCP provider ${providerId} returned tool ${record.name} with malformed inputSchema`)
    }

    return {
        name: record.name,
        description: record.description,
        inputSchema: record.inputSchema as Record<string, unknown> | undefined,
    }
}

function validateToolsCallResult(providerId: string, toolName: string, value: unknown): ToolsCallResult {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`MCP provider ${providerId} returned malformed tools/call result for ${toolName}`)
    }

    const record = value as ToolsCallResult
    if (record.content !== undefined && !Array.isArray(record.content)) {
        throw new Error(`MCP provider ${providerId} returned malformed tools/call content for ${toolName}`)
    }

    if (record.isError !== undefined && typeof record.isError !== "boolean") {
        throw new Error(`MCP provider ${providerId} returned malformed tools/call isError for ${toolName}`)
    }

    return record
}

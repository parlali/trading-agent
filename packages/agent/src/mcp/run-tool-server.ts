import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { isIP } from "node:net"
import type { Logger } from "@valiq-trading/core"
import { projectToolsForMcp } from "../tool-projections/mcp"
import type { ToolExecutionEngine } from "../tool-execution-engine"
import type { ToolRegistry } from "../tool-registry"

export interface RunToolServerConfig {
    tools: ToolRegistry
    toolEngine: ToolExecutionEngine
    logger: Logger
    host?: string
    token?: string
    signal?: AbortSignal
    onFatalFault?: () => Promise<void> | void
}

export interface RunToolServer {
    url: string
    token: string
    toolNames: string[]
    close(): Promise<void>
}

interface JsonRpcRequest {
    jsonrpc?: "2.0"
    id?: string | number | null
    method?: string
    params?: unknown
}

interface JsonRpcResponse {
    jsonrpc: "2.0"
    id: string | number | null
    result?: unknown
    error?: {
        code: number
        message: string
        data?: unknown
    }
}

type McpFatalState = {
    active: boolean
}

const DEFAULT_HOST = "127.0.0.1"
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024

export async function startRunToolServer(config: RunToolServerConfig): Promise<RunToolServer> {
    const host = config.host ?? DEFAULT_HOST
    const token = config.token ?? randomBytes(32).toString("base64url")
    const projectedTools = projectToolsForMcp(config.tools.getAll())
    const toolNames = projectedTools.map((tool) => tool.name)
    const fatalState: McpFatalState = {
        active: false,
    }

    const server = createServer(async (request, response) => {
        try {
            await handleRequest({
                request,
                response,
                token,
                projectedTools,
                toolEngine: config.toolEngine,
                logger: config.logger,
                onFatalFault: config.onFatalFault,
                fatalState,
                signal: config.signal,
            })
        } catch (error) {
            config.logger.error("Run MCP server request failed", {
                error: error instanceof Error ? error.message : String(error),
            })
            writeJson(response, 500, {
                jsonrpc: "2.0",
                id: null,
                error: {
                    code: -32603,
                    message: "Internal MCP server error",
                },
            })
        }
    })

    await listen(server, host, 0)
    const address = server.address()
    if (!address || typeof address === "string") {
        server.close()
        throw new Error("Run MCP server did not bind to a TCP port")
    }

    const url = `http://${formatMcpUrlHost(host)}:${address.port}/mcp`
    config.logger.info("Run MCP server ready", {
        url,
        toolCount: projectedTools.length,
    })

    let closed = false

    return {
        url,
        token,
        toolNames,
        close: async () => {
            if (closed) {
                return
            }
            closed = true
            config.logger.info("Run MCP server shutting down", {
                url,
                toolCount: projectedTools.length,
            })
            await closeServer(server)
        },
    }
}

async function handleRequest(args: {
    request: IncomingMessage
    response: ServerResponse
    token: string
    projectedTools: ReturnType<typeof projectToolsForMcp>
    toolEngine: ToolExecutionEngine
    logger: Logger
    onFatalFault?: () => Promise<void> | void
    fatalState: McpFatalState
    signal?: AbortSignal
}): Promise<void> {
    const { request, response } = args

    if (request.method !== "POST" || request.url !== "/mcp") {
        writeJson(response, 404, { error: "Not found" })
        return
    }

    if (request.headers.authorization !== `Bearer ${args.token}`) {
        writeJson(response, 401, { error: "Unauthorized" })
        return
    }

    let parsed: JsonRpcRequest | JsonRpcRequest[]
    try {
        const body = await readRequestBody(request)
        const candidate = JSON.parse(body) as unknown
        if (!isJsonRpcRequest(candidate) && !Array.isArray(candidate)) {
            writeJson(response, 400, jsonRpcError(null, -32600, "Invalid JSON-RPC request"))
            return
        }
        if (Array.isArray(candidate) && candidate.length === 0) {
            writeJson(response, 400, jsonRpcError(null, -32600, "Invalid JSON-RPC request"))
            return
        }
        parsed = candidate as JsonRpcRequest | JsonRpcRequest[]
    } catch (error) {
        args.logger.error("Run MCP server rejected invalid request", {
            error: error instanceof Error ? error.message : String(error),
        })
        if (error instanceof RequestBodyTooLargeError) {
            writeJson(response, 413, jsonRpcError(null, -32600, "Request body too large"))
            return
        }
        if (error instanceof SyntaxError) {
            writeJson(response, 400, jsonRpcError(null, -32700, "Parse error"))
            return
        }
        throw error
    }
    const requests = Array.isArray(parsed) ? parsed : [parsed]
    const responses: JsonRpcResponse[] = []

    for (const requestPayload of requests) {
        if (!isJsonRpcRequest(requestPayload)) {
            responses.push(jsonRpcError(null, -32600, "Invalid JSON-RPC request"))
            continue
        }
        const responsePayload = await handleJsonRpcRequest({
            request: requestPayload,
            projectedTools: args.projectedTools,
            toolEngine: args.toolEngine,
            logger: args.logger,
            onFatalFault: args.onFatalFault,
            fatalState: args.fatalState,
            signal: args.signal,
        })
        if (responsePayload) {
            responses.push(responsePayload)
        }
        if (args.fatalState.active) {
            break
        }
    }

    if (responses.length === 0) {
        response.writeHead(202)
        response.end()
        return
    }

    writeJson(response, 200, Array.isArray(parsed) ? responses : responses[0])
}

async function handleJsonRpcRequest(args: {
    request: JsonRpcRequest
    projectedTools: ReturnType<typeof projectToolsForMcp>
    toolEngine: ToolExecutionEngine
    logger: Logger
    onFatalFault?: () => Promise<void> | void
    fatalState: McpFatalState
    signal?: AbortSignal
}): Promise<JsonRpcResponse | undefined> {
    const { request } = args
    const id = request.id ?? null

    if (!request.method) {
        return jsonRpcError(id, -32600, "Invalid JSON-RPC request")
    }

    if (request.id === undefined || request.id === null) {
        return undefined
    }

    if (request.method === "initialize") {
        return jsonRpcResult(id, {
            protocolVersion: "2025-06-18",
            capabilities: {
                tools: {},
            },
            serverInfo: {
                name: "valiq-run-tools",
                version: "1.0.0",
            },
            instructions: "Run-scoped trading tools. Execute only the listed tools for this strategy run.",
        })
    }

    if (request.method === "tools/list") {
        args.logger.info("Run MCP server listed tools", {
            toolCount: args.projectedTools.length,
        })
        return jsonRpcResult(id, {
            tools: args.projectedTools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
                annotations: tool.annotations,
            })),
        })
    }

    if (request.method === "tools/call") {
        if (args.fatalState.active) {
            return jsonRpcError(id, -32000, "Run MCP server stopped after fatal tool fault")
        }

        const params = readRecord(request.params)
        const name = typeof params?.name === "string" ? params.name : ""
        if (!name) {
            return jsonRpcError(id, -32602, "MCP tools/call requires params.name")
        }

        const result = await args.toolEngine.executeMcpCall(
            name,
            params?.arguments ?? {},
            String(id),
            {
                signal: args.signal,
            }
        )
        args.logger.info("Run MCP server completed tool call", {
            toolName: name,
            isError: result.isError,
            fatal: result.fatal,
        })

        if (result.fatal) {
            args.fatalState.active = true
            await Promise.resolve(args.onFatalFault?.()).catch((error) => {
                args.logger.error("Run MCP fatal-fault hook failed", {
                    error: error instanceof Error ? error.message : String(error),
                })
            })
        }

        return jsonRpcResult(id, {
            content: [{
                type: "text",
                text: result.content,
            }],
            isError: result.isError,
        })
    }

    return jsonRpcError(id, -32601, `Unsupported MCP method: ${request.method}`)
}

function jsonRpcResult(id: string | number | null, result: unknown): JsonRpcResponse {
    return {
        jsonrpc: "2.0",
        id,
        result,
    }
}

function jsonRpcError(
    id: string | number | null,
    code: number,
    message: string,
    data?: unknown
): JsonRpcResponse {
    return {
        jsonrpc: "2.0",
        id,
        error: {
            code,
            message,
            data,
        },
    }
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, {
        "Content-Type": "application/json",
    })
    response.end(JSON.stringify(body))
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = []
    let total = 0

    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        total += buffer.length
        if (total > MAX_REQUEST_BODY_BYTES) {
            throw new RequestBodyTooLargeError("MCP request body exceeded size limit")
        }
        chunks.push(buffer)
    }

    return Buffer.concat(chunks).toString("utf8")
}

function listen(server: Server, host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(port, host, () => {
            server.off("error", reject)
            resolve()
        })
    })
}

function closeServer(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => {
            if (error) {
                reject(error)
                return
            }
            resolve()
        })
    })
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
    return Boolean(readRecord(value))
}

export function formatMcpUrlHost(host: string): string {
    return isIP(host) === 6 ? `[${host}]` : host
}

class RequestBodyTooLargeError extends Error {}

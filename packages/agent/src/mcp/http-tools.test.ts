import { afterEach, describe, expect, it, vi } from "vitest"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { createLogger } from "@valiq-trading/core"
import { ToolExecutionEngine } from "../tool-execution-engine"
import { ToolRegistry } from "../tool-registry"
import { createHttpMcpToolBindings } from "./http-tools"

describe("HTTP MCP tool bindings", () => {
    const servers: Array<{ close: () => void }> = []

    afterEach(() => {
        for (const server of servers.splice(0)) {
            server.close()
        }
        vi.restoreAllMocks()
    })

    it("discovers namespaced MCP tools and calls the upstream tool name", async () => {
        const receivedCalls: Array<Record<string, unknown>> = []
        const server = await startMcpServer(async (request, response) => {
            const body = await readJsonBody(request)
            receivedCalls.push(body)
            const method = body.method

            if (method === "initialize") {
                writeJsonRpc(response, body.id, {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    serverInfo: { name: "research-server", version: "1.0.0" },
                })
                return
            }

            if (method === "notifications/initialized") {
                response.writeHead(202)
                response.end()
                return
            }

            if (method === "tools/list") {
                writeJsonRpc(response, body.id, {
                    tools: [{
                        name: "search",
                        description: "Search external research",
                        inputSchema: {
                            type: "object",
                            properties: {
                                query: { type: "string" },
                            },
                            required: ["query"],
                        },
                    }],
                })
                return
            }

            if (method === "tools/call") {
                writeJsonRpc(response, body.id, {
                    content: [{
                        type: "text",
                        text: "research result",
                    }],
                })
                return
            }

            writeJsonRpcError(response, body.id, -32601, "method not found")
        })
        servers.push(server)

        const tools = await createHttpMcpToolBindings({
            providers: [{
                id: "macro",
                url: server.url,
                token: "secret",
            }],
            logger: createLogger({ minLevel: "fatal" }),
        })

        expect(tools.map((tool) => tool.name)).toEqual(["mcp_macro_search"])
        expect(tools[0]?.category).toBe("research")

        const result = await tools[0]?.handler({ query: "rates" })

        expect(result).toMatchObject({
            content: [{
                type: "text",
                text: "research result",
            }],
        })
        expect(receivedCalls.find((call) => call.method === "tools/call")).toMatchObject({
            params: {
                name: "search",
                arguments: { query: "rates" },
            },
        })
    })

    it("degrades repeated MCP research failures through tool category", async () => {
        const tools = await createHttpMcpToolBindings({
            providers: [{
                id: "macro",
                url: await createFailingMcpServerUrl(),
            }],
            logger: createLogger({ minLevel: "fatal" }),
        })
        const registry = new ToolRegistry()
        for (const tool of tools) {
            registry.register(tool)
        }
        const engine = new ToolExecutionEngine({
            tools: registry,
            context: {
                runId: "run-mcp",
                strategyId: "strategy-mcp",
                app: "polymarket",
                timestamp: Date.now(),
                trigger: "cron",
                positions: [],
                accountState: {
                    balance: 0,
                    equity: 0,
                    buyingPower: 0,
                    marginUsed: 0,
                    marginAvailable: 0,
                    openPnl: 0,
                    dayPnl: 0,
                },
                policy: {},
                context: "",
            },
            logger: createLogger({ minLevel: "fatal" }),
            runStartedAt: Date.now(),
            runTimeoutMs: 60_000,
            maxRepeatedToolErrors: 3,
        })

        for (let index = 0; index < 3; index++) {
            await engine.executeMcpCall("mcp_macro_search", { query: "rates" }, `call-${index}`)
        }

        expect(engine.getOutcome().fatalFault).toBeUndefined()
        expect(engine.getOutcome().degradedResearch(true)).toMatchObject({
            active: true,
            decisionUnderDegradedContext: true,
            toolFailureCount: 1,
        })
    })

    async function createFailingMcpServerUrl(): Promise<string> {
        const server = await startMcpServer(async (request, response) => {
            const body = await readJsonBody(request)

            if (body.method === "initialize") {
                writeJsonRpc(response, body.id, {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    serverInfo: { name: "failing-server", version: "1.0.0" },
                })
                return
            }

            if (body.method === "notifications/initialized") {
                response.writeHead(202)
                response.end()
                return
            }

            if (body.method === "tools/list") {
                writeJsonRpc(response, body.id, {
                    tools: [{
                        name: "search",
                        inputSchema: {
                            type: "object",
                            properties: {
                                query: { type: "string" },
                            },
                        },
                    }],
                })
                return
            }

            if (body.method === "tools/call") {
                writeJsonRpcError(response, body.id, -32000, "provider unavailable")
                return
            }

            writeJsonRpcError(response, body.id, -32601, "method not found")
        })
        servers.push(server)
        return server.url
    }
})

async function startMcpServer(
    handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
): Promise<{ url: string; close: () => void }> {
    const server = createServer((request, response) => {
        handler(request, response).catch((error) => {
            response.writeHead(500, { "Content-Type": "text/plain" })
            response.end(error instanceof Error ? error.message : String(error))
        })
    })

    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve)
    })

    const address = server.address()
    if (!address || typeof address === "string") {
        throw new Error("Test MCP server did not bind to a TCP port")
    }

    return {
        url: `http://127.0.0.1:${address.port}`,
        close: () => server.close(),
    }
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    for await (const chunk of request) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
    }

    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
}

function writeJsonRpc(response: ServerResponse, id: unknown, result: unknown): void {
    writeJson(response, {
        jsonrpc: "2.0",
        id,
        result,
    })
}

function writeJsonRpcError(response: ServerResponse, id: unknown, code: number, message: string): void {
    writeJson(response, {
        jsonrpc: "2.0",
        id,
        error: {
            code,
            message,
        },
    })
}

function writeJson(response: ServerResponse, body: unknown): void {
    response.writeHead(200, { "Content-Type": "application/json" })
    response.end(JSON.stringify(body))
}

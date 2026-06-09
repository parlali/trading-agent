import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { createLogger } from "@valiq-trading/core"
import { ToolExecutionEngine } from "../tool-execution-engine"
import { ToolRegistry } from "../tool-registry"
import { formatMcpUrlHost, startRunToolServer } from "./run-tool-server"

describe("startRunToolServer", () => {
    it("lists run-scoped tools from the active registry", async () => {
        const harness = await createHarness()
        try {
            const response = await rpc(harness.url, harness.token, {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/list",
            })

            expect(response).toMatchObject({
                result: {
                    tools: [{
                        name: "echo",
                        inputSchema: {
                            type: "object",
                        },
                    }],
                },
            })
        } finally {
            await harness.close()
        }
    })

    it("rejects missing or invalid bearer tokens", async () => {
        const harness = await createHarness()
        try {
            const missing = await fetch(harness.url, {
                method: "POST",
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "tools/list",
                }),
            })
            const invalid = await fetch(harness.url, {
                method: "POST",
                headers: {
                    Authorization: "Bearer wrong",
                },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "tools/list",
                }),
            })

            expect(missing.status).toBe(401)
            expect(invalid.status).toBe(401)
        } finally {
            await harness.close()
        }
    })

    it("returns protocol errors for malformed or oversized requests", async () => {
        const harness = await createHarness()
        try {
            const malformed = await fetch(harness.url, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${harness.token}`,
                },
                body: "{",
            })
            const malformedBody = await malformed.json() as { error?: { code?: number } }
            const oversized = await fetch(harness.url, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${harness.token}`,
                },
                body: "x".repeat(2 * 1024 * 1024 + 1),
            })
            const oversizedBody = await oversized.json() as { error?: { code?: number; message?: string } }

            expect(malformed.status).toBe(400)
            expect(malformedBody.error?.code).toBe(-32700)
            expect(oversized.status).toBe(413)
            expect(oversizedBody.error).toMatchObject({
                code: -32600,
                message: "Request body too large",
            })
        } finally {
            await harness.close()
        }
    })

    it("executes a fake tool through the shared execution engine", async () => {
        const harness = await createHarness()
        try {
            const response = await rpc(harness.url, harness.token, {
                jsonrpc: "2.0",
                id: "call-1",
                method: "tools/call",
                params: {
                    name: "echo",
                    arguments: {
                        value: "hello",
                    },
                },
            })

            expect(response).toMatchObject({
                result: {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ echo: "hello" }),
                    }],
                    isError: false,
                },
            })
            expect(harness.calls).toEqual([{ value: "hello" }])
        } finally {
            await harness.close()
        }
    })

    it("stops a batch after a fatal tool fault", async () => {
        const onFatalFault = vi.fn()
        const harnessCalls: string[] = []
        const harness = await createHarness({
            category: "execution",
            onFatalFault,
            handler: async (params) => {
                const value = params as { value: string }
                harnessCalls.push(value.value)
                if (value.value === "fatal") {
                    throw new Error("provider credential missing")
                }
                return {
                    echo: value.value,
                }
            },
        })
        try {
            const response = await rpc(harness.url, harness.token, [
                {
                    jsonrpc: "2.0",
                    id: "call-fatal",
                    method: "tools/call",
                    params: {
                        name: "echo",
                        arguments: {
                            value: "fatal",
                        },
                    },
                },
                {
                    jsonrpc: "2.0",
                    id: "call-after-fatal",
                    method: "tools/call",
                    params: {
                        name: "echo",
                        arguments: {
                            value: "after",
                        },
                    },
                },
            ]) as unknown as { result?: { isError?: boolean } }[]

            expect(response).toHaveLength(1)
            expect(response[0]?.result?.isError).toBe(true)
            expect(harnessCalls).toEqual(["fatal"])
            expect(onFatalFault).toHaveBeenCalledTimes(1)
        } finally {
            await harness.close()
        }
    })

    it("rejects tool calls after a fatal tool fault", async () => {
        const harness = await createHarness({
            category: "execution",
            handler: async (params) => {
                const value = params as { value: string }
                if (value.value === "fatal") {
                    throw new Error("provider credential missing")
                }
                return {
                    echo: value.value,
                }
            },
        })
        try {
            await rpc(harness.url, harness.token, {
                jsonrpc: "2.0",
                id: "call-fatal",
                method: "tools/call",
                params: {
                    name: "echo",
                    arguments: {
                        value: "fatal",
                    },
                },
            })
            const response = await rpc(harness.url, harness.token, {
                jsonrpc: "2.0",
                id: "call-after-fatal",
                method: "tools/call",
                params: {
                    name: "echo",
                    arguments: {
                        value: "after",
                    },
                },
            })

            expect(response.error).toMatchObject({
                code: -32000,
                message: "Run MCP server stopped after fatal tool fault",
            })
        } finally {
            await harness.close()
        }
    })

    it("does not accept tool calls after the run server closes", async () => {
        const harness = await createHarness()
        await harness.close()

        await expect(fetch(harness.url, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${harness.token}`,
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/list",
            }),
        })).rejects.toThrow()
    })

    it("formats IPv6 MCP URL hosts with brackets", () => {
        expect(formatMcpUrlHost("::1")).toBe("[::1]")
        expect(formatMcpUrlHost("127.0.0.1")).toBe("127.0.0.1")
    })
})

async function createHarness(options: {
    category?: "research" | "execution"
    handler?: (params: unknown) => Promise<unknown>
    onFatalFault?: () => Promise<void> | void
} = {}): Promise<{
    url: string
    token: string
    calls: Array<{ value: string }>
    close(): Promise<void>
}> {
    const calls: Array<{ value: string }> = []
    const tools = new ToolRegistry()
    tools.register({
        name: "echo",
        description: "Echo input",
        parameters: z.object({
            value: z.string(),
        }),
        jsonSchema: {
            type: "object",
            properties: {
                value: {
                    type: "string",
                },
            },
            required: ["value"],
        },
        category: options.category ?? "research",
        handler: options.handler ?? (async (params) => {
            const value = params as { value: string }
            calls.push(value)
            return {
                echo: value.value,
            }
        }),
    })
    const toolEngine = new ToolExecutionEngine({
        tools,
        context: createContext(),
        logger: createLogger({ minLevel: "fatal" }),
        runStartedAt: Date.now(),
        runTimeoutMs: 60_000,
    })
    const server = await startRunToolServer({
        tools,
        toolEngine,
        logger: createLogger({ minLevel: "fatal" }),
        onFatalFault: options.onFatalFault,
    })

    return {
        url: server.url,
        token: server.token,
        calls,
        close: server.close,
    }
}

async function rpc(url: string, token: string, payload: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
    })

    expect(response.status).toBe(200)
    return await response.json() as Record<string, unknown>
}

function createContext() {
    return {
        runId: "run-mcp-test",
        strategyId: "strategy-mcp-test",
        app: "polymarket" as const,
        timestamp: Date.now(),
        trigger: "cron" as const,
        positions: [],
        accountState: {
            balance: 10_000,
            equity: 10_000,
            buyingPower: 10_000,
            marginUsed: 0,
            marginAvailable: 10_000,
            openPnl: 0,
            dayPnl: 0,
        },
        policy: {
            dryRun: true,
            llm: {
                provider: "openrouter",
                model: "test",
            },
        },
        context: "test",
    }
}

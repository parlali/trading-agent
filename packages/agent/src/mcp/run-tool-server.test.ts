import { describe, expect, it } from "vitest"
import { z } from "zod"
import { createLogger } from "@valiq-trading/core"
import { ToolExecutionEngine } from "../tool-execution-engine"
import { ToolRegistry } from "../tool-registry"
import { startRunToolServer } from "./run-tool-server"

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
})

async function createHarness(): Promise<{
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
        category: "research",
        handler: async (params) => {
            const value = params as { value: string }
            calls.push(value)
            return {
                echo: value.value,
            }
        },
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

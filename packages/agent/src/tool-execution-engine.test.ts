import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { createLogger } from "@valiq-trading/core"
import { ToolExecutionEngine } from "./tool-execution-engine"
import { ToolRegistry } from "./tool-registry"
import type { ToolCall } from "./llm-client"

describe("ToolExecutionEngine", () => {
    it("returns bounded errors for unknown tools and invalid OpenRouter JSON", async () => {
        const engine = createEngine(async () => ({ shouldNotRun: true }))
        const openRouterResults: Array<{ content: string }> = []

        const unknown = await engine.executeMcpCall("missing_tool", {}, "call-missing")
        await engine.executeOpenRouterBatch([{
            id: "call-invalid-json",
            type: "function",
            function: {
                name: "fake_tool",
                arguments: "{",
            },
        }], {
            onToolResult: (result) => {
                openRouterResults.push(result)
            },
            onUserMessage: () => undefined,
        })

        expect(unknown.content).toContain("Unknown tool: missing_tool")
        expect(unknown.isError).toBe(true)
        expect(openRouterResults[0]?.content).toContain("Invalid JSON arguments")
    })

    it("runs equivalent fake tool calls through OpenRouter batch mode and MCP single-call mode", async () => {
        const openRouterHandler = vi.fn(async (params: unknown) => ({
            accepted: true,
            params,
        }))
        const mcpHandler = vi.fn(async (params: unknown) => ({
            accepted: true,
            params,
        }))
        const openRouterEngine = createEngine(openRouterHandler)
        const mcpEngine = createEngine(mcpHandler)
        const openRouterResults: Array<{ toolName: string; content: string; rawInput: string }> = []

        await openRouterEngine.executeOpenRouterBatch([{
            id: "call-1",
            type: "function",
            function: {
                name: "fake_tool",
                arguments: JSON.stringify({ value: "same-input" }),
            },
        } satisfies ToolCall], {
            onToolResult: (result) => {
                openRouterResults.push(result)
            },
            onUserMessage: () => undefined,
        })
        const mcpResult = await mcpEngine.executeMcpCall(
            "fake_tool",
            { value: "same-input" },
            "call-1"
        )

        expect(openRouterHandler).toHaveBeenCalledWith({ value: "same-input" }, expect.objectContaining({
            signal: expect.any(AbortSignal),
        }))
        expect(mcpHandler).toHaveBeenCalledWith({ value: "same-input" }, expect.objectContaining({
            signal: expect.any(AbortSignal),
        }))
        expect(openRouterResults).toEqual([{
            toolCallId: "call-1",
            toolName: "fake_tool",
            content: mcpResult.content,
            rawInput: JSON.stringify({ value: "same-input" }),
        }])
        expect(mcpResult.isError).toBe(false)
    })

    it("truncates model-facing tool results on both transports", async () => {
        const longPayload = "x".repeat(8001)
        const openRouterEngine = createEngine(async () => longPayload)
        const mcpEngine = createEngine(async () => longPayload)
        const openRouterResults: Array<{ content: string }> = []

        await openRouterEngine.executeOpenRouterBatch([{
            id: "call-long",
            type: "function",
            function: {
                name: "fake_tool",
                arguments: JSON.stringify({ value: "long" }),
            },
        }], {
            onToolResult: (result) => {
                openRouterResults.push(result)
            },
            onUserMessage: () => undefined,
        })
        const mcpResult = await mcpEngine.executeMcpCall(
            "fake_tool",
            { value: "long" },
            "call-long"
        )

        expect(openRouterResults[0]?.content).toContain("...[truncated from 8001 chars]")
        expect(mcpResult.content).toContain("...[truncated from 8001 chars]")
    })

    it("returns validation errors before invoking the handler on both transports", async () => {
        const handler = vi.fn(async () => ({ shouldNotRun: true }))
        const openRouterEngine = createEngine(handler)
        const mcpEngine = createEngine(handler)
        const openRouterResults: Array<{ content: string }> = []

        await openRouterEngine.executeOpenRouterBatch([{
            id: "call-invalid",
            type: "function",
            function: {
                name: "fake_tool",
                arguments: JSON.stringify({ value: 42 }),
            },
        }], {
            onToolResult: (result) => {
                openRouterResults.push(result)
            },
            onUserMessage: () => undefined,
        })
        const mcpResult = await mcpEngine.executeMcpCall(
            "fake_tool",
            { value: 42 },
            "call-invalid"
        )

        expect(handler).not.toHaveBeenCalled()
        expect(openRouterResults[0]?.content).toContain("Parameter validation failed")
        expect(mcpResult.content).toContain("Parameter validation failed")
        expect(mcpResult.isError).toBe(true)
    })

    it("degrades repeated research failures instead of tripping the fatal circuit breaker", async () => {
        const tools = new ToolRegistry()
        tools.register({
            name: "search_markets",
            description: "Search markets",
            parameters: z.object({
                query: z.string(),
            }),
            jsonSchema: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                    },
                },
                required: ["query"],
            },
            category: "research",
            handler: async () => {
                throw new Error("provider unavailable")
            },
        })
        const engine = new ToolExecutionEngine({
            tools,
            context: createContext(),
            logger: createLogger({ minLevel: "fatal" }),
            runStartedAt: Date.now(),
            runTimeoutMs: 60_000,
            maxRepeatedToolErrors: 3,
        })

        for (let i = 0; i < 3; i++) {
            await engine.executeMcpCall("search_markets", { query: "rates" }, `call-${i}`)
        }

        const outcome = engine.getOutcome()
        expect(outcome.fatalFault).toBeUndefined()
        expect(outcome.degradedResearch(true)).toMatchObject({
            active: true,
            decisionUnderDegradedContext: true,
        })
    })

    it("fails closed after repeated non-research validation errors", async () => {
        const engine = createEngine(async () => ({ shouldNotRun: true }))

        for (let i = 0; i < 3; i++) {
            await engine.executeMcpCall("fake_tool", { value: 42 }, `call-${i}`)
        }

        const outcome = engine.getOutcome()
        expect(outcome.fatalFault).toMatchObject({
            toolName: "fake_tool",
            reason: "repeated identical fake_tool tool error",
        })
    })

    it("fails closed after repeated non-research execution failures", async () => {
        const engine = createEngine(async () => {
            throw new Error("venue temporarily unavailable")
        })

        for (let i = 0; i < 3; i++) {
            await engine.executeMcpCall("fake_tool", { value: "valid" }, `call-${i}`)
        }

        const outcome = engine.getOutcome()
        expect(outcome.fatalFault).toMatchObject({
            toolName: "fake_tool",
            reason: "repeated identical fake_tool tool error",
        })
    })

    it("returns tool timeout errors without invoking fatal state on first failure", async () => {
        const engine = createEngine(async () => new Promise(() => undefined), {
            maxToolTimeoutMs: 1,
            minToolTimeoutMs: 1,
        })

        const result = await engine.executeMcpCall("fake_tool", { value: "slow" }, "call-timeout")

        expect(result.content).toContain("Tool execution failed: Tool timed out after")
        expect(result.isError).toBe(true)
        expect(result.fatal).toBe(false)
    })

    it("does not invoke handlers once the overall run timeout is exhausted", async () => {
        const handler = vi.fn(async () => ({ shouldNotRun: true }))
        const engine = createEngine(handler, {
            runStartedAt: Date.now() - 10_000,
            runTimeoutMs: 1,
        })

        const result = await engine.executeMcpCall("fake_tool", { value: "late" }, "call-late")

        expect(handler).not.toHaveBeenCalled()
        expect(result.content).toContain("run timeout was exhausted")
        expect(result.isError).toBe(true)
    })

    it("aborts timed-out handlers through the tool signal", async () => {
        let observedSignal: AbortSignal | undefined
        const engine = createEngine(async (_params, context) => {
            observedSignal = context?.signal
            return await new Promise(() => {
                context?.signal?.addEventListener("abort", () => undefined, { once: true })
            })
        }, {
            maxToolTimeoutMs: 1,
            minToolTimeoutMs: 1,
        })

        const result = await engine.executeMcpCall("fake_tool", { value: "slow" }, "call-abort")

        expect(observedSignal?.aborted).toBe(true)
        expect(result.content).toContain("Tool timed out after")
    })

    it("serializes MT5 OpenRouter tool batches", async () => {
        const events: string[] = []
        const engine = createEngine(async (params: unknown) => {
            const value = (params as { value: string }).value
            events.push(`start:${value}`)
            await Promise.resolve()
            events.push(`finish:${value}`)
            return { value }
        }, {
            app: "mt5",
        })

        await engine.executeOpenRouterBatch([
            {
                id: "call-first",
                type: "function",
                function: {
                    name: "fake_tool",
                    arguments: JSON.stringify({ value: "first" }),
                },
            },
            {
                id: "call-second",
                type: "function",
                function: {
                    name: "fake_tool",
                    arguments: JSON.stringify({ value: "second" }),
                },
            },
        ], {
            onToolResult: () => undefined,
            onUserMessage: () => undefined,
        })

        expect(events).toEqual([
            "start:first",
            "finish:first",
            "start:second",
            "finish:second",
        ])
    })
})

function createEngine(
    handler: (params: unknown, context?: { signal?: AbortSignal }) => Promise<unknown>,
    options: {
        app?: "polymarket" | "mt5"
        maxToolTimeoutMs?: number
        minToolTimeoutMs?: number
        runStartedAt?: number
        runTimeoutMs?: number
    } = {}
): ToolExecutionEngine {
    const tools = new ToolRegistry()
    tools.register({
        name: "fake_tool",
        description: "Fake tool",
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
        category: "execution",
        handler,
    })

    return new ToolExecutionEngine({
        tools,
        context: createContext(options.app ?? "polymarket"),
        logger: createLogger({ minLevel: "fatal" }),
        runStartedAt: options.runStartedAt ?? Date.now(),
        runTimeoutMs: options.runTimeoutMs ?? 60_000,
        maxToolTimeoutMs: options.maxToolTimeoutMs,
        minToolTimeoutMs: options.minToolTimeoutMs,
        maxRepeatedToolErrors: 3,
    })
}

function createContext(app: "polymarket" | "mt5" = "polymarket") {
    return {
        runId: "run-tool-engine-test",
        strategyId: "strategy-tool-engine-test",
        app,
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

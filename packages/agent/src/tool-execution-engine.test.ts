import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { createLogger } from "@valiq-trading/core"
import { ToolExecutionEngine } from "./tool-execution-engine"
import { ToolRegistry } from "./tool-registry"
import { withCallBudget } from "./tools"
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
        expect(engine.getOutcome().toolCallCount).toBe(2)
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
        expect(openRouterEngine.getOutcome().toolCallCount).toBe(1)
        expect(mcpEngine.getOutcome().toolCallCount).toBe(1)
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

    it("returns a bounded MCP warning after the configured tool call budget is exhausted", async () => {
        const handler = vi.fn(async () => ({ accepted: true }))
        const engine = createEngine(handler, {
            maxToolCalls: 1,
        })

        const first = await engine.executeMcpCall("fake_tool", { value: "first" }, "call-1")
        const second = await engine.executeMcpCall("fake_tool", { value: "second" }, "call-2")

        expect(first.isError).toBe(false)
        expect(second.isError).toBe(false)
        expect(second.content).toContain("Tool call budget reached after 1 calls")
        expect(handler).toHaveBeenCalledTimes(1)
        expect(engine.getOutcome().toolCallCount).toBe(1)
    })

    it("budgets generic discovered MCP dispatcher calls by upstream tool name", async () => {
        const handler = vi.fn(async (params: unknown) => ({ params }))
        const tools = new ToolRegistry()
        tools.register(withCallBudget({
            name: "mcp_provider_call_discovered_tool",
            description: "Call discovered MCP tool",
            parameters: z.object({
                toolName: z.string(),
                arguments: z.record(z.string(), z.unknown()).optional(),
            }),
            category: "research",
            contractOwner: "mcp:provider",
            callBudgetKey: (params) => {
                const input = params as { toolName?: unknown }
                return typeof input.toolName === "string"
                    ? `mcp_provider_call_discovered_tool:${input.toolName}`
                    : undefined
            },
            handler,
        }, 2))
        const engine = new ToolExecutionEngine({
            tools,
            context: createContext("polymarket"),
            logger: createLogger({ minLevel: "fatal" }),
            runStartedAt: Date.now(),
            runTimeoutMs: 60_000,
            maxRepeatedToolErrors: 3,
        })

        await engine.executeMcpCall("mcp_provider_call_discovered_tool", { toolName: "first" }, "call-1")
        await engine.executeMcpCall("mcp_provider_call_discovered_tool", { toolName: "first" }, "call-2")
        const firstExhausted = await engine.executeMcpCall("mcp_provider_call_discovered_tool", { toolName: "first" }, "call-3")
        const secondFirst = await engine.executeMcpCall("mcp_provider_call_discovered_tool", { toolName: "second" }, "call-4")
        const secondSecond = await engine.executeMcpCall("mcp_provider_call_discovered_tool", { toolName: "second" }, "call-5")

        expect(firstExhausted.isError).toBe(true)
        expect(firstExhausted.content).toContain("mcp_provider_call_discovered_tool:first")
        expect(secondFirst.isError).toBe(false)
        expect(secondSecond.isError).toBe(false)
        expect(handler).toHaveBeenCalledTimes(4)
    })

    it("does not fail MCP tool calls when transcript logging fails", async () => {
        const agentLogger = {
            log: vi.fn(async () => {
                throw new Error("transcript unavailable")
            }),
        }
        const engine = createEngine(async () => ({ accepted: true }), {
            agentLogger,
            nextTranscriptSequence: () => 3,
        })

        const result = await engine.executeMcpCall(
            "fake_tool",
            { value: "valid" },
            "call-logging"
        )

        expect(result.isError).toBe(false)
        expect(result.content).toContain("accepted")
        expect(agentLogger.log).toHaveBeenCalledTimes(1)
    })

    it("uses the runtime transcript sequence allocator for MCP tool logs", async () => {
        let sequence = 2
        const agentLogger = {
            log: vi.fn(async (
                _runId: string,
                _strategyId: string,
                _sequence: number,
                _role: string,
                _content: string,
                _toolName?: string,
                _toolInput?: string,
                _toolOutput?: string
            ) => undefined),
        }
        const engine = createEngine(async () => ({ accepted: true }), {
            agentLogger,
            nextTranscriptSequence: () => {
                sequence++
                return sequence
            },
        })

        await engine.executeMcpCall("fake_tool", { value: "valid" }, "call-sequence")

        expect(agentLogger.log.mock.calls[0]?.[2]).toBe(3)
    })

    it("fails closed when transcript logging is configured without a sequence allocator", () => {
        expect(() => new ToolExecutionEngine({
            tools: new ToolRegistry(),
            context: createContext(),
            logger: createLogger({ minLevel: "fatal" }),
            agentLogger: {
                log: vi.fn(async () => undefined),
            },
            runStartedAt: Date.now(),
            runTimeoutMs: 60_000,
        })).toThrow("requires nextTranscriptSequence")
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
        expect(openRouterEngine.getOutcome().toolCallCount).toBe(1)
        expect(mcpEngine.getOutcome().toolCallCount).toBe(1)
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

    it("degrades repeated MCP tool-level errors returned in fulfilled results", async () => {
        const tools = new ToolRegistry()
        tools.register({
            name: "mcp_macro_search",
            description: "MCP search",
            parameters: z.object({
                query: z.string(),
            }),
            category: "research",
            contractOwner: "mcp:macro",
            handler: async () => ({
                isError: true,
                content: [{
                    type: "text",
                    text: "provider unavailable",
                }],
            }),
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
            await engine.executeMcpCall("mcp_macro_search", { query: "rates" }, `call-${i}`)
        }

        expect(engine.getOutcome().fatalFault).toBeUndefined()
        expect(engine.getOutcome().degradedResearch(true)).toMatchObject({
            active: true,
            toolFailureCount: 1,
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

    it("fails closed on the first execution tool timeout", async () => {
        const engine = createEngine(async () => new Promise(() => undefined), {
            maxToolTimeoutMs: 1,
        })

        const result = await engine.executeMcpCall("fake_tool", { value: "slow" }, "call-timeout")

        expect(result.content).toContain("Tool execution failed: Tool timed out after")
        expect(result.isError).toBe(true)
        expect(result.fatal).toBe(true)
        expect(engine.getOutcome().fatalFault).toMatchObject({
            toolName: "fake_tool",
            reason: "safety-critical fake_tool tool failure",
        })
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
        expect(engine.getOutcome().toolCallCount).toBe(1)
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
        })

        const result = await engine.executeMcpCall("fake_tool", { value: "slow" }, "call-abort")

        expect(observedSignal?.aborted).toBe(true)
        expect(result.content).toContain("Tool timed out after")
    })

    it("serializes execution-capable OpenRouter tool batches", async () => {
        const events: string[] = []
        const engine = createEngine(async (params: unknown) => {
            const value = (params as { value: string }).value
            events.push(`start:${value}`)
            await Promise.resolve()
            events.push(`finish:${value}`)
            return { value }
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

    it("stops remaining execution-capable tools after a fatal tool failure", async () => {
        const handler = vi.fn(async () => {
            throw new Error("provider credential missing")
        })
        const engine = createEngine(handler)
        const openRouterResults: Array<{ content: string }> = []

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
            onToolResult: (result) => {
                openRouterResults.push(result)
            },
            onUserMessage: () => undefined,
        })

        expect(handler).toHaveBeenCalledTimes(1)
        expect(openRouterResults).toHaveLength(1)
        expect(engine.getOutcome().toolCallCount).toBe(1)
        expect(engine.getOutcome().fatalFault).toMatchObject({
            toolName: "fake_tool",
            reason: "safety-critical fake_tool tool failure",
        })
    })
})

function createEngine(
    handler: (params: unknown, context?: { signal?: AbortSignal }) => Promise<unknown>,
    options: {
        app?: "polymarket" | "mt5"
        maxToolTimeoutMs?: number
        maxToolCalls?: number
        runStartedAt?: number
        runTimeoutMs?: number
        agentLogger?: {
            log: (
                runId: string,
                strategyId: string,
                sequence: number,
                role: string,
                content: string,
                toolName?: string,
                toolInput?: string,
                toolOutput?: string
            ) => Promise<void>
        }
        nextTranscriptSequence?: () => number
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
        agentLogger: options.agentLogger,
        runStartedAt: options.runStartedAt ?? Date.now(),
        runTimeoutMs: options.runTimeoutMs ?? 60_000,
        maxToolTimeoutMs: options.maxToolTimeoutMs,
        maxToolCalls: options.maxToolCalls,
        maxRepeatedToolErrors: 3,
        nextTranscriptSequence: options.nextTranscriptSequence,
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

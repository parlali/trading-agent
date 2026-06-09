import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import {
    DRY_RUN_ACCOUNT_LEDGER_INSTRUMENT,
    ExecutionPipeline,
    createLogger,
    type AccountState,
    type ExecutionResult,
    type Position,
    type StrategyRunContext,
    type VenueAdapter,
} from "@valiq-trading/core"
import { ToolExecutionEngine, type ToolExecutionOutcome } from "./tool-execution-engine"
import { ToolRegistry, type ToolBinding } from "./tool-registry"
import type { ToolCall } from "./llm-client"
import { createPolymarketGetMarketPriceTool } from "./tools/get-market-price-polymarket"
import { createPolymarketProposeOrderTool } from "./tools/propose-order-polymarket"

interface ReplayToolCall {
    id: string
    name: string
    args: unknown
}

interface ReplayResult {
    toolResults: string[]
    warnings: string[]
    outcome: ToolExecutionOutcome
}

interface FakeReplayProvider {
    readonly name: "openrouter" | "codex-mcp"
    run(engine: ToolExecutionEngine, calls: ReplayToolCall[]): Promise<ReplayResult>
}

describe("provider-neutral tool execution replays", () => {
    it("replays observed truncated Polymarket token-id failures through OpenRouter and Codex MCP paths", async () => {
        for (const provider of fakeProviders) {
            const venue = {
                getMarketPrice: vi.fn(),
            }
            const registry = new ToolRegistry()
            registry.register(createPolymarketGetMarketPriceTool(venue as never))
            const replay = await runReplay(provider, registry, [
                createCall("call-invalid-1", "get_market_price", { tokenId: "425888" }),
                createCall("call-invalid-2", "get_market_price", { tokenId: "425888" }),
                createCall("call-invalid-3", "get_market_price", { tokenId: "425888" }),
            ])

            expect(venue.getMarketPrice, provider.name).not.toHaveBeenCalled()
            expect(replay.toolResults.join("\n"), provider.name).toContain("Polymarket tokenId must be the canonical")
            expect(replay.outcome.fatalFault, provider.name).toMatchObject({
                toolName: "get_market_price",
                reason: "repeated identical get_market_price tool error",
            })
        }
    })

    it("replays repeated search_markets failures through both provider paths as degraded research", async () => {
        for (const provider of fakeProviders) {
            const registry = new ToolRegistry()
            registry.register(createSearchMarketsTool())
            const replay = await runReplay(provider, registry, [
                createCall("call-search-1", "search_markets", { query: "rates" }),
                createCall("call-search-2", "search_markets", { query: "rates" }),
                createCall("call-search-3", "search_markets", { query: "rates" }),
            ])
            const degradedResearch = replay.outcome.degradedResearch(true)

            expect(replay.outcome.fatalFault, provider.name).toBeUndefined()
            expect(degradedResearch, provider.name).toMatchObject({
                active: true,
                decisionUnderDegradedContext: true,
                toolFailureCount: 1,
            })
            expect(degradedResearch.reasons.join("\n"), provider.name).toContain("search_markets")
        }
    })

    it("replays repeated execution-tool failures through both provider paths as fail-closed", async () => {
        for (const provider of fakeProviders) {
            const registry = new ToolRegistry()
            registry.register(createFailingExecutionTool())
            const replay = await runReplay(provider, registry, [
                createCall("call-exec-1", "fake_execution", { value: "same" }),
                createCall("call-exec-2", "fake_execution", { value: "same" }),
                createCall("call-exec-3", "fake_execution", { value: "same" }),
            ])

            expect(replay.outcome.fatalFault, provider.name).toMatchObject({
                toolName: "fake_execution",
                reason: "repeated identical fake_execution tool error",
            })
            expect(replay.outcome.abortReason, provider.name).toBe("repeated identical fake_execution tool error")
        }
    })

    it("replays dry-run accounting through both provider paths with identical positions and execution diagnostics", async () => {
        const openRouter = await runDryRunAccountingReplay(new FakeOpenRouterReplayProvider())
        const codexMcp = await runDryRunAccountingReplay(new FakeCodexMcpReplayProvider())

        expect(codexMcp.syncedPositions).toEqual(openRouter.syncedPositions)
        expect(codexMcp.outcome.opportunityCoverage).toEqual(openRouter.outcome.opportunityCoverage)
        expect(openRouter.outcome.fatalFault).toBeUndefined()
        expect(openRouter.outcome.opportunityCoverage).toMatchObject({
            qualified: 1,
            submitted: 1,
            filled: 1,
        })
        const tokenId = dryRunReplayTokenId()
        expect(openRouter.syncedPositions).toContainEqual(expect.objectContaining({
            instrument: tokenId,
            side: "long",
            quantity: 2,
            entryPrice: 0.5,
        }))
        expect(openRouter.syncedPositions).toContainEqual(expect.objectContaining({
            instrument: DRY_RUN_ACCOUNT_LEDGER_INSTRUMENT,
            metadata: expect.objectContaining({
                dryRunLedger: true,
                cashAdjustment: -1,
                balance: 999,
                equity: 1000,
            }),
        }))
    })
})

class FakeOpenRouterReplayProvider implements FakeReplayProvider {
    readonly name = "openrouter" as const

    async run(engine: ToolExecutionEngine, calls: ReplayToolCall[]): Promise<ReplayResult> {
        const toolResults: string[] = []
        const warnings: string[] = []

        await engine.executeOpenRouterBatch(calls.map((call) => ({
            id: call.id,
            type: "function",
            function: {
                name: call.name,
                arguments: JSON.stringify(call.args),
            },
        } satisfies ToolCall)), {
            onToolResult: (result) => {
                toolResults.push(result.content)
            },
            onUserMessage: (content) => {
                warnings.push(content)
            },
        })

        return {
            toolResults,
            warnings,
            outcome: engine.getOutcome(),
        }
    }
}

class FakeCodexMcpReplayProvider implements FakeReplayProvider {
    readonly name = "codex-mcp" as const

    async run(engine: ToolExecutionEngine, calls: ReplayToolCall[]): Promise<ReplayResult> {
        const toolResults: string[] = []

        for (const call of calls) {
            const result = await engine.executeMcpCall(call.name, call.args, call.id)
            toolResults.push(result.content)
        }

        return {
            toolResults,
            warnings: [],
            outcome: engine.getOutcome(),
        }
    }
}

const fakeProviders: FakeReplayProvider[] = [
    new FakeOpenRouterReplayProvider(),
    new FakeCodexMcpReplayProvider(),
]

async function runReplay(
    provider: FakeReplayProvider,
    tools: ToolRegistry,
    calls: ReplayToolCall[]
): Promise<ReplayResult> {
    return await provider.run(new ToolExecutionEngine({
        tools,
        context: createContext(),
        logger: createLogger({ minLevel: "fatal" }),
        runStartedAt: Date.now(),
        runTimeoutMs: 60_000,
        maxRepeatedToolErrors: 3,
    }), calls)
}

async function runDryRunAccountingReplay(provider: FakeReplayProvider): Promise<{
    syncedPositions: Position[]
    outcome: ToolExecutionOutcome
    toolResults: string[]
}> {
    const policy = {
        dryRun: true,
        dryRunInitialCash: 1000,
    }
    const pipeline = new ExecutionPipeline({
        venue: createDryRunReplayVenue(),
        venueName: "polymarket",
        policy,
        riskValidators: [() => ({ allowed: true })],
        logger: createLogger({ minLevel: "fatal" }),
        runId: "run-dry-run-accounting-replay",
        strategyId: "strategy-dry-run-accounting-replay",
    })
    const tools = new ToolRegistry()
    tools.register(createPolymarketProposeOrderTool(pipeline, createDryRunReplayVenue()))

    try {
        const replay = await provider.run(new ToolExecutionEngine({
            tools,
            context: createContext(policy),
            logger: createLogger({ minLevel: "fatal" }),
            runStartedAt: Date.now(),
            runTimeoutMs: 60_000,
            maxRepeatedToolErrors: 3,
        }), [
            createCall("call-dry-run-order", "propose_order", {
                tokenId: dryRunReplayTokenId(),
                conditionId: "condition-dry-run-accounting",
                marketSlug: "dry-run-accounting-replay",
                question: "Will this deterministic replay remain balanced?",
                outcome: "Yes",
                side: "buy",
                quantity: 2,
                orderType: "limit",
                limitPrice: 0.5,
                timeInForce: "gtc",
            }),
        ])

        return {
            syncedPositions: pipeline.getDryRunPositionsForSync(),
            outcome: replay.outcome,
            toolResults: replay.toolResults,
        }
    } finally {
        pipeline.stopAllTracking()
    }
}

function createCall(id: string, name: string, args: unknown): ReplayToolCall {
    return {
        id,
        name,
        args,
    }
}

function createSearchMarketsTool(): ToolBinding {
    return {
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
            throw new Error("404 Not Found")
        },
    }
}

function createFailingExecutionTool(): ToolBinding {
    return {
        name: "fake_execution",
        description: "Fake execution tool",
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
        handler: async () => {
            throw new Error("venue unavailable")
        },
    }
}

function createContext(policy: Record<string, unknown> = {
    dryRun: true,
    llm: {
        provider: "openrouter",
        model: "test",
    },
}): StrategyRunContext {
    return {
        runId: "run-provider-neutral-replay",
        strategyId: "strategy-provider-neutral-replay",
        app: "polymarket",
        timestamp: Date.now(),
        trigger: "cron",
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
        policy,
        context: "provider-neutral replay",
    }
}

function dryRunReplayTokenId(): string {
    return "123456789012345678901234567890"
}

function createDryRunReplayVenue(): VenueAdapter & { getPrice(tokenId: string, side: "buy" | "sell"): Promise<number> } {
    const account: AccountState = {
        balance: 1000,
        equity: 1000,
        buyingPower: 1000,
        marginUsed: 0,
        marginAvailable: 1000,
        openPnl: 0,
        dayPnl: 0,
    }

    return {
        getPositions: vi.fn(async () => []),
        getAccountState: vi.fn(async () => account),
        submitOrder: vi.fn(async () => rejectedExecutionResult()),
        cancelOrder: vi.fn(async () => rejectedExecutionResult()),
        modifyOrder: vi.fn(async () => rejectedExecutionResult()),
        closePosition: vi.fn(async () => rejectedExecutionResult()),
        getOrderStatus: vi.fn(async () => rejectedExecutionResult()),
        getPrice: vi.fn(async () => 0.5),
    }
}

function rejectedExecutionResult(): ExecutionResult {
    return {
        orderId: "unused",
        status: "rejected",
        filledQuantity: 0,
        timestamp: Date.now(),
        error: "not exercised",
    }
}

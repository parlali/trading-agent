import { describe, expect, it } from "vitest"
import {
    createLogger,
    ExecutionPipeline,
    type AccountState,
    type ExecutionResult,
    type Position,
    type StrategyRunContext,
} from "@valiq-trading/core"
import { buildSystemPrompt } from "./prompt-builder"
import { createGetPositionsTool } from "./tools/get-positions"

function createContext(): StrategyRunContext {
    return {
        runId: "run-1",
        strategyId: "strategy-1",
        app: "okx-swap",
        timestamp: Date.parse("2026-04-20T10:00:00.000Z"),
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
        policy: {
            dryRun: true,
            model: "gpt-5.4",
            safety: {
                account: {
                    allocationPercent: 100,
                },
            },
        },
        context: "test context",
    }
}

describe("buildSystemPrompt previous-run handoff", () => {
    it("isolates manual Polymarket external positions from prompts and get_positions until adoption", async () => {
        const accountState: AccountState = {
            balance: 10_000,
            equity: 10_000,
            buyingPower: 10_000,
            marginUsed: 0,
            marginAvailable: 10_000,
            openPnl: 0,
            dayPnl: 0,
        }
        const ownedPosition: Position = {
            instrument: "1000000000000000000000000000000000000001",
            providerPositionId: "owned-polymarket-position",
            side: "long",
            quantity: 12,
            entryPrice: 0.42,
            currentPrice: 0.44,
        }
        const manualExternalPosition: Position = {
            instrument: "2000000000000000000000000000000000000002",
            providerPositionId: "manual-polymarket-position",
            side: "long",
            quantity: 7,
            entryPrice: 0.61,
            currentPrice: 0.57,
            metadata: {
                marketSlug: "will-the-us-acquire-any-part-of-greenland-in-2026",
                question: "Will the US acquire any part of Greenland in 2026?",
                tokenId: "2000000000000000000000000000000000000002",
            },
        }
        const context = createContext()
        context.app = "polymarket"
        context.positions = [ownedPosition]
        context.accountState = accountState
        context.runtimeContextLines = [
            `Owned Polymarket token ${ownedPosition.instrument} remains eligible for management.`,
            "Manual external Polymarket row will-the-us-acquire-any-part-of-greenland-in-2026 2000000000000000000000000000000000000002",
        ]
        context.previousRunSummary = {
            summary: "Prior handoff mentioned will-the-us-acquire-any-part-of-greenland-in-2026 and 2000000000000000000000000000000000000002.",
            endedAt: Date.parse("2026-04-20T09:30:00.000Z"),
        }
        context.promptSanitizer = {
            blockedIdentifiers: [
                "will-the-us-acquire-any-part-of-greenland-in-2026",
                "2000000000000000000000000000000000000002",
                "Will the US acquire any part of Greenland in 2026?",
            ],
        }

        const prompt = buildSystemPrompt(context, [])

        expect(prompt).toContain(ownedPosition.instrument)
        expect(prompt).not.toContain("will-the-us-acquire-any-part-of-greenland-in-2026")
        expect(prompt).not.toContain("2000000000000000000000000000000000000002")
        expect(prompt).not.toContain("Will the US acquire any part of Greenland in 2026?")

        const venue = {
            getPositions: async () => [ownedPosition, manualExternalPosition],
            getAccountState: async () => accountState,
            submitOrder: async () => rejectedExecutionResult(),
            cancelOrder: async () => rejectedExecutionResult(),
            modifyOrder: async () => rejectedExecutionResult(),
            closePosition: async () => rejectedExecutionResult(),
            getOrderStatus: async () => rejectedExecutionResult(),
        }
        const scopedPipeline = new ExecutionPipeline({
            venue,
            venueName: "polymarket",
            policy: { dryRun: false },
            logger: createLogger({ minLevel: "fatal" }),
            runId: "run-polymarket-isolation",
            strategyId: "strategy-polymarket",
            ownershipScope: {
                instruments: new Set([ownedPosition.instrument]),
                positionKeys: new Set([`${ownedPosition.instrument}:${ownedPosition.providerPositionId}`]),
                workingOrderIds: new Set(),
            },
        })
        const getPositions = createGetPositionsTool(scopedPipeline)
        const scopedResult = await getPositions.handler({}) as { positions: Position[] }

        expect(scopedResult.positions).toEqual([ownedPosition])
    })
})

function rejectedExecutionResult(): ExecutionResult {
    return {
        orderId: "",
        status: "rejected",
        filledQuantity: 0,
        timestamp: Date.now(),
    }
}

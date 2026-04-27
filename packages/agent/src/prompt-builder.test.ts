import { describe, expect, it } from "vitest"
import type { StrategyRunContext } from "@valiq-trading/core"
import { buildSystemPrompt } from "./prompt-builder"

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
            model: "openai/gpt-5.5",
            reasoning: {
                effort: "medium",
                exclude: true,
            },
            safety: {
                expectedExternalInstruments: ["will-the-us-acquire-any-part-of-greenland-in-2026"],
                account: {
                    allocationPercent: 100,
                },
            },
        },
        context: "test context",
        previousRunSummary: {
            summary: `${"X".repeat(7000)}\n---METADATA---\n{"nextRunInMinutes": 5}\n---END METADATA---`,
            endedAt: Date.parse("2026-04-20T09:30:00.000Z"),
            systemContextDigest: {
                schemaVersion: 1,
                generatedAt: Date.parse("2026-04-20T09:30:00.000Z"),
                risk: {
                    safetyState: "cooldown",
                    dayRealizedPnl: -120,
                    weekRealizedPnl: -240,
                    dayDrawdownLimit: 200,
                    weekDrawdownLimit: 500,
                    cooldownActive: true,
                    cooldownReason: "day_drawdown",
                    cooldownExpiresAt: Date.parse("2026-04-20T12:00:00.000Z"),
                    blockedInstruments: ["BTC-USDT-SWAP"],
                    forcedExitClusterInstruments: [],
                    unresolvedExecutionFaultCount: 0,
                },
                recentTrades: {
                    dayEntries: 2,
                    dayCloses: 2,
                    dayForcedExits: 0,
                    dayRejectedOrTerminal: 1,
                    weekRealizedPnl: -240,
                    closeOutStreakDirection: "loss",
                    closeOutStreakCount: 1,
                },
                pendingOrders: [],
            },
        },
    }
}

describe("buildSystemPrompt previous-run handoff", () => {
    it("includes the persisted system digest and bounded prior summary", () => {
        const prompt = buildSystemPrompt(createContext(), [])

        expect(prompt).toContain("Canonical previous-run system digest")
        expect(prompt).toContain("Risk posture: cooldown")
        expect(prompt).toContain("[truncated for bounded handoff context]")
        expect(prompt.split("---METADATA---").length - 1).toBe(1)
    })

    it("removes expected-external identifiers from policy and handoff context", () => {
        const context = createContext()
        context.app = "polymarket"
        context.previousRunSummary = {
            summary: "Watch will-the-us-acquire-any-part-of-greenland-in-2026, token-greenland-yes, and Greenland question before acting.",
            endedAt: Date.parse("2026-04-20T09:30:00.000Z"),
            systemContextDigest: {
                schemaVersion: 1,
                generatedAt: Date.parse("2026-04-20T09:30:00.000Z"),
                risk: {
                    safetyState: "healthy",
                    dayRealizedPnl: 0,
                    weekRealizedPnl: 0,
                    dayDrawdownLimit: 200,
                    weekDrawdownLimit: 500,
                    cooldownActive: false,
                    blockedInstruments: ["will-the-us-acquire-any-part-of-greenland-in-2026"],
                    forcedExitClusterInstruments: [],
                    unresolvedExecutionFaultCount: 0,
                },
                recentTrades: {
                    dayEntries: 0,
                    dayCloses: 0,
                    dayForcedExits: 0,
                    dayRejectedOrTerminal: 0,
                    weekRealizedPnl: 0,
                    closeOutStreakDirection: undefined,
                    closeOutStreakCount: 0,
                },
                pendingOrders: [],
            },
        }
        context.runtimeContextLines = [
            "Current Polymarket execution context: will-the-us-acquire-any-part-of-greenland-in-2026 token-greenland-yes",
        ]
        context.promptSanitizer = {
            blockedIdentifiers: [
                "will-the-us-acquire-any-part-of-greenland-in-2026",
                "token-greenland-yes",
                "Greenland question",
            ],
        }

        const prompt = buildSystemPrompt(context, [])

        expect(prompt).not.toContain("will-the-us-acquire-any-part-of-greenland-in-2026")
        expect(prompt).not.toContain("token-greenland-yes")
        expect(prompt).not.toContain("expectedExternalInstruments")
        expect(prompt).not.toContain("Greenland question")
        expect(prompt).not.toContain("openai/gpt-5.5")
        expect(prompt).not.toContain("reasoning")
    })
})

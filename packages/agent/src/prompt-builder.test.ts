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
})

import { describe, expect, it } from "vitest"
import {
    buildRunSystemContextDigest,
    formatRunSystemContextDigestLines,
    truncateHandoffSummary,
    type PendingOrderContext,
    type StrategyRiskState,
} from "./index"

describe("run system context digest", () => {
    it("builds a bounded canonical digest and formats deterministic prompt lines", () => {
        const riskState: StrategyRiskState = {
            strategyId: "strategy-1",
            app: "okx-swap",
            safetyState: "blocked",
            day: {
                realizedPnl: -125,
                limit: 200,
                progress: 0.625,
            },
            week: {
                realizedPnl: -220,
                limit: 500,
                progress: 0.44,
            },
            cooldown: {
                active: true,
                reason: "forced_exit_cluster",
                startedAt: Date.parse("2026-04-17T10:00:00.000Z"),
                expiresAt: Date.parse("2026-04-17T13:00:00.000Z"),
            },
            unresolvedExecutionFaultCount: 2,
            blockedInstruments: Array.from({ length: 25 }, (_, index) => `BLOCK-${index + 1}`),
            forcedExitClusterInstruments: Array.from({ length: 30 }, (_, index) => `FORCED-${index + 1}`),
            lastUpdatedAt: Date.parse("2026-04-17T12:00:00.000Z"),
        }

        const pendingOrders: PendingOrderContext[] = Array.from({ length: 15 }, (_, index) => ({
            orderId: `order-${index + 1}`,
            instrument: "BTC-USDT-SWAP",
            action: "entry",
            status: "pending",
            quantity: 1,
            filledQuantity: 0,
            remainingQuantity: 1,
            submittedAt: Date.parse("2026-04-17T12:00:00.000Z"),
            updatedAt: Date.parse("2026-04-17T12:00:00.000Z"),
            cancelAt: Date.parse("2026-04-17T13:00:00.000Z"),
            recommendedAction: "refresh",
        }))

        const digest = buildRunSystemContextDigest({
            generatedAt: Date.parse("2026-04-17T12:30:00.000Z"),
            riskState,
            recentTrades: {
                dayEntries: 4,
                dayCloses: 3,
                dayForcedExits: 2,
                dayRejectedOrTerminal: 1,
                weekRealizedPnl: -220,
                closeOutStreakDirection: "loss",
                closeOutStreakCount: 2,
            },
            pendingOrders,
        })

        expect(digest.schemaVersion).toBe(1)
        expect(digest.pendingOrders).toHaveLength(12)
        expect(digest.risk.blockedInstruments).toHaveLength(20)
        expect(digest.risk.forcedExitClusterInstruments).toHaveLength(20)

        const lines = formatRunSystemContextDigestLines(digest)
        expect(lines.some((line) => line.includes("Risk posture: blocked"))).toBe(true)
        expect(lines.some((line) => line.includes("Recent trade digest (same day): entries 4"))).toBe(true)
        expect(lines.some((line) => line.includes("Active pending-order digest"))).toBe(true)
    })

    it("truncates oversized previous-run handoff summaries deterministically", () => {
        const summary = "A".repeat(7000)
        const truncated = truncateHandoffSummary(summary)

        expect(truncated.length).toBeLessThan(summary.length)
        expect(truncated).toContain("[truncated for bounded handoff context]")
    })
})

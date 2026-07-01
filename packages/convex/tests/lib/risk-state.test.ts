import { describe, expect, it, vi } from "vitest"
import { refreshStrategyRiskState } from "../../convex/lib/mutations/risk"
import { callRegistered, FakeMutationDb as FakeDb } from "./fakeMutationDb"

describe("Convex risk state refresh", () => {
    it("uses current risk windows instead of all historical filled orders", async () => {
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const strategyId = "strategy-risk-window"
        const now = Date.parse("2026-07-01T12:00:00.000Z")
        const oldCloseAt = Date.parse("2026-06-20T12:00:00.000Z")
        const weekCloseAt = Date.parse("2026-07-01T11:00:00.000Z")
        const db = new FakeDb({
            strategies: [{
                _id: strategyId,
                app: "mt5",
                accountId: "primary",
                name: "MT5 Risk Window",
                policy: { dryRun: false },
            }],
            orders: [{
                _id: "order-old-close",
                strategyId,
                status: "filled",
                action: "close",
                instrument: "XAUUSD",
                updatedAt: oldCloseAt,
                filledQuantity: 1,
                avgFillPrice: 100,
                intent: {
                    metadata: {
                        fillPnl: -999,
                    },
                },
            }, {
                _id: "order-week-close",
                strategyId,
                status: "filled",
                action: "close",
                instrument: "XAUUSD",
                updatedAt: weekCloseAt,
                filledQuantity: 1,
                avgFillPrice: 100,
                intent: {
                    metadata: {
                        fillPnl: -12,
                    },
                },
            }],
            strategy_risk_states: [],
            execution_safety_faults: [{
                _id: "fault-open",
                strategyId,
                app: "mt5",
                accountId: "primary",
                instrument: "XAUUSD",
                category: "position_not_found_yet",
                message: "provider truth unresolved",
                blocked: true,
                occurredAt: weekCloseAt,
            }, {
                _id: "fault-resolved",
                strategyId,
                app: "mt5",
                accountId: "primary",
                instrument: "EURUSD",
                category: "position_not_found_yet",
                message: "already resolved",
                blocked: false,
                occurredAt: oldCloseAt,
                resolvedAt: oldCloseAt + 1_000,
            }],
            alerts: [],
        })
        const ctx = { db } as never

        vi.useFakeTimers()
        vi.setSystemTime(now)
        try {
            const result = await callRegistered(refreshStrategyRiskState, ctx, {
                serviceToken: "test-token",
                strategyId,
                app: "mt5",
                policy: {
                    maxDrawdownDay: 100,
                    maxDrawdownWeek: 200,
                    cooldownMinutesAfterDayBreach: 60,
                    cooldownMinutesAfterWeekBreach: 120,
                    strategyTimezone: "UTC",
                },
            })

            expect(result).toMatchObject({
                day: {
                    realizedPnl: -12,
                },
                week: {
                    realizedPnl: -12,
                },
                safetyState: "execution_degraded",
                blockedInstruments: ["XAUUSD"],
                unresolvedExecutionFaultCount: 1,
            })
            expect(db.rows.strategy_risk_states).toContainEqual(expect.objectContaining({
                strategyId,
                dayRealizedPnl: -12,
                weekRealizedPnl: -12,
                safetyState: "execution_degraded",
                unresolvedExecutionFaultCount: 1,
            }))
        } finally {
            vi.useRealTimers()
        }
    })
})

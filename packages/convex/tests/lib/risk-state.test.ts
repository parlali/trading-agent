import { describe, expect, it, vi } from "vitest"
import { refreshStrategyRiskState } from "../../convex/lib/mutations/risk"
import {
    getGateEvaluationStats,
    computeSuiteLossState,
    getSuiteLossState,
    type GateEvaluationStats,
    type SuiteLossState,
} from "../../convex/lib/queries/risk"
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

        const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now)
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
            nowSpy.mockRestore()
        }
    })
})

describe("suite loss state", () => {
    it("sums latest equity per mt5 account when account snapshots interleave", async () => {
        const now = Date.parse("2026-07-01T12:00:00.000Z")
        const dayStart = Date.parse("2026-07-01T00:00:00.000Z")
        const weekStart = Date.parse("2026-06-29T00:00:00.000Z")

        const state = await callSuiteLossQuery({
            accounts: [
                createAccount("mt5", "account-a"),
                createAccount("mt5", "account-b"),
            ],
            account_snapshots: [
                createSuiteSnapshot("week-b", "mt5", "account-b", weekStart, 10_000),
                createSuiteSnapshot("week-a", "mt5", "account-a", weekStart, 10_000),
                createSuiteSnapshot("day-b", "mt5", "account-b", dayStart, 10_000),
                createSuiteSnapshot("day-a", "mt5", "account-a", dayStart, 10_000),
                createSuiteSnapshot("latest-b", "mt5", "account-b", now - 120_000, 9_800),
                createSuiteSnapshot("latest-a", "mt5", "account-a", now - 60_000, 10_050),
            ],
        }, now)

        expect(state.blocked).toBe(false)
        expect(state.dayChangePercent).toBeCloseTo(-0.75)
        expect(state.weekChangePercent).toBeCloseTo(-0.75)
    })

    it("blocks when one mt5 account drawdown breaches the summed daily book", async () => {
        const now = Date.parse("2026-07-01T12:00:00.000Z")
        const dayStart = Date.parse("2026-07-01T00:00:00.000Z")

        const state = await callSuiteLossQuery({
            accounts: [
                createAccount("mt5", "account-a"),
                createAccount("mt5", "account-b"),
            ],
            account_snapshots: [
                createSuiteSnapshot("day-b", "mt5", "account-b", dayStart, 10_000),
                createSuiteSnapshot("day-a", "mt5", "account-a", dayStart, 10_000),
                createSuiteSnapshot("latest-b", "mt5", "account-b", now - 120_000, 9_300),
                createSuiteSnapshot("latest-a", "mt5", "account-a", now - 60_000, 10_000),
            ],
        }, now)

        expect(state.blocked).toBe(true)
        expect(state.dayChangePercent).toBeCloseTo(-3.5)
        expect(state.reason).toContain("Suite loss stop active")
    })

    it("ignores a freshly registered mt5 account with no snapshots", async () => {
        const now = Date.parse("2026-07-01T12:00:00.000Z")
        const dayStart = Date.parse("2026-07-01T00:00:00.000Z")

        const state = await callSuiteLossQuery({
            accounts: [
                createAccount("mt5", "funded"),
                createAccount("mt5", "fresh"),
            ],
            account_snapshots: [
                createSuiteSnapshot("day-funded", "mt5", "funded", dayStart, 10_000),
                createSuiteSnapshot("latest-funded", "mt5", "funded", now - 60_000, 9_900),
            ],
        }, now)

        expect(state.blocked).toBe(false)
        expect(state.dayChangePercent).toBeCloseTo(-1)
    })

    it("blocks new entries when combined real-account equity breaches the daily loss stop", () => {
        const state = computeSuiteLossState([{
            app: "mt5",
            latest: {
                balance: 9_690,
            },
            dayBaseline: {
                balance: 10_000,
            },
            weekBaseline: {
                balance: 10_000,
            },
        }], Date.parse("2026-07-01T12:00:00.000Z"))

        expect(state.blocked).toBe(true)
        expect(state.dayChangePercent).toBeCloseTo(-3.1)
        expect(state.reason).toContain("Suite loss stop active")
    })
})

describe("gate evaluation stats", () => {
    it("aggregates recent gate records and counts near misses", async () => {
        const previousToken = process.env.BACKEND_SERVICE_TOKEN
        process.env.BACKEND_SERVICE_TOKEN = "test-token"
        const strategyId = "strategy-gate-stats"
        const db = new FakeDb({
            trade_events: [
                createGateEvent("event-1", strategyId, true, [{
                    gateKey: "mt5.minRiskReward",
                    observed: 2.2,
                    threshold: 2,
                    margin: 0.1,
                }]),
                createGateEvent("event-2", strategyId, true, [{
                    gateKey: "mt5.minRiskReward",
                    observed: 3,
                    threshold: 2,
                    margin: 0.5,
                }]),
                createGateEvent("event-3", strategyId, false, [{
                    gateKey: "mt5.maxRiskPercent",
                    observed: 0.5,
                    threshold: 1,
                    margin: 0.5,
                }, {
                    gateKey: "mt5.minRiskReward",
                    observed: 1,
                    threshold: 2,
                    margin: -0.5,
                }]),
            ],
        })

        try {
            const stats = await callRegistered(getGateEvaluationStats, { db } as never, {
                serviceToken: "test-token",
                strategyId,
                gateKey: "mt5.minRiskReward",
                limit: 10,
            }) as GateEvaluationStats

            expect(stats).toEqual({
                evaluations: 3,
                rejections: 1,
                nearMisses: 1,
                minMargin: -0.5,
                maxMargin: 0.5,
            })
        } finally {
            if (previousToken === undefined) {
                delete process.env.BACKEND_SERVICE_TOKEN
            } else {
                process.env.BACKEND_SERVICE_TOKEN = previousToken
            }
        }
    })
})

async function callSuiteLossQuery(
    rows: Record<string, Array<Record<string, unknown>>>,
    evaluatedAt: number
): Promise<SuiteLossState> {
    const previousToken = process.env.BACKEND_SERVICE_TOKEN
    process.env.BACKEND_SERVICE_TOKEN = "test-token"
    const db = new FakeDb(rows)
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(evaluatedAt)

    try {
        return await callRegistered(getSuiteLossState, { db } as never, {
            serviceToken: "test-token",
        }) as SuiteLossState
    } finally {
        nowSpy.mockRestore()
        if (previousToken === undefined) {
            delete process.env.BACKEND_SERVICE_TOKEN
        } else {
            process.env.BACKEND_SERVICE_TOKEN = previousToken
        }
    }
}

function createAccount(app: string, accountId: string): Record<string, unknown> {
    return {
        _id: `account-${app}-${accountId}`,
        app,
        accountId,
        label: accountId,
        credentialEnvPrefix: accountId.toUpperCase().replace(/-/g, "_"),
        status: "active",
        createdAt: 0,
        updatedAt: 0,
    }
}

function createSuiteSnapshot(
    id: string,
    app: string,
    accountId: string,
    timestamp: number,
    equity: number
): Record<string, unknown> {
    return {
        _id: id,
        app,
        accountId,
        venue: app,
        balance: equity,
        equity,
        buyingPower: equity,
        marginUsed: 0,
        marginAvailable: equity,
        openPnl: 0,
        dayPnl: 0,
        timestamp,
    }
}

function createGateEvent(
    id: string,
    strategyId: string,
    allowed: boolean,
    gateEvaluations: Array<{
        gateKey: string
        observed: number
        threshold: number
        margin: number
    }>
): Record<string, unknown> {
    return {
        _id: id,
        runId: "run-gates",
        strategyId,
        eventType: allowed ? "validation" : "rejected",
        payload: JSON.stringify({
            result: {
                allowed,
                gateEvaluations,
            },
            intent: {
                instrument: "XAUUSD",
            },
        }),
        timestamp: Date.now(),
    }
}

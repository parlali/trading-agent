import { describe, expect, it } from "vitest"
import {
    computeRecentTradeDigest,
    computeRiskGovernanceState,
    createStrategySafetyValidator,
    resolveRiskWindowStarts,
    type AccountState,
    type OrderIntent,
    type Position,
    type RiskGovernanceOrderRecord,
} from "./index"

const account: AccountState = {
    balance: 10_000,
    equity: 10_000,
    buyingPower: 10_000,
    marginUsed: 0,
    marginAvailable: 10_000,
    openPnl: 0,
    dayPnl: 0,
}

const noPositions: Position[] = []

function closeOrder(args: {
    instrument: string
    updatedAt: number
    entryPrice: number
    closePrice: number
    filledQuantity: number
    positionSide: "long" | "short"
    forcedExit?: boolean
}): RiskGovernanceOrderRecord {
    return {
        action: "close",
        status: "filled",
        instrument: args.instrument,
        updatedAt: args.updatedAt,
        filledQuantity: args.filledQuantity,
        avgFillPrice: args.closePrice,
        intent: {
            metadata: {
                entryPrice: args.entryPrice,
                positionSide: args.positionSide,
                forcedExit: args.forcedExit,
            },
        },
    }
}

function entryIntent(instrument = "BTC-USDT-SWAP"): OrderIntent {
    return {
        instrument,
        side: "buy",
        quantity: 1,
        orderType: "market",
        timeInForce: "gtc",
        metadata: {
            action: "entry",
        },
    }
}

describe("risk governance replay", () => {
    it("returns identical cooldown and safety decisions for identical event history", () => {
        const now = Date.parse("2026-04-17T14:30:00.000Z")
        const orders: RiskGovernanceOrderRecord[] = [
            closeOrder({
                instrument: "BTC-USDT-SWAP",
                updatedAt: Date.parse("2026-04-17T08:00:00.000Z"),
                entryPrice: 100,
                closePrice: 90,
                filledQuantity: 10,
                positionSide: "long",
            }),
            closeOrder({
                instrument: "ETH-USDT-SWAP",
                updatedAt: Date.parse("2026-04-17T09:00:00.000Z"),
                entryPrice: 200,
                closePrice: 190,
                filledQuantity: 5,
                positionSide: "long",
            }),
        ]

        const first = computeRiskGovernanceState({
            now,
            orders,
            faults: [],
            policy: {
                maxDrawdownDay: 120,
                maxDrawdownWeek: 500,
                cooldownMinutesAfterDayBreach: 120,
                cooldownMinutesAfterWeekBreach: 240,
                strategyTimezone: "UTC",
            },
        })

        const second = computeRiskGovernanceState({
            now,
            orders,
            faults: [],
            policy: {
                maxDrawdownDay: 120,
                maxDrawdownWeek: 500,
                cooldownMinutesAfterDayBreach: 120,
                cooldownMinutesAfterWeekBreach: 240,
                strategyTimezone: "UTC",
            },
        })

        expect(second).toEqual(first)
        expect(first.safetyState).toBe("cooldown")
        expect(first.cooldown.reason).toBe("day_drawdown")
    })

    it("uses provider-reported fill PnL and settlement-currency fees for close orders", () => {
        const now = Date.parse("2026-05-14T12:00:00.000Z")
        const result = computeRiskGovernanceState({
            now,
            orders: [
                {
                    action: "close",
                    status: "filled",
                    instrument: "ETH-USDT-SWAP",
                    updatedAt: Date.parse("2026-05-14T09:36:17.000Z"),
                    filledQuantity: 7.306,
                    avgFillPrice: 2255.84,
                    intent: {
                        metadata: {
                            entryPrice: 2263.5,
                            positionSide: "short",
                            fillPnl: 55.97,
                            fee: -41.5,
                            feeCcy: "USDT",
                        },
                    },
                },
            ],
            faults: [],
            policy: {
                cooldownMinutesAfterDayBreach: 120,
                cooldownMinutesAfterWeekBreach: 240,
                strategyTimezone: "UTC",
            },
        })

        expect(result.dayRealizedPnl).toBeCloseTo(14.47)
        expect(result.weekRealizedPnl).toBeCloseTo(14.47)
    })

    it("expires cooldown deterministically when expiry is passed", () => {
        const now = Date.parse("2026-04-17T18:00:00.000Z")
        const result = computeRiskGovernanceState({
            now,
            orders: [],
            faults: [],
            policy: {
                cooldownMinutesAfterDayBreach: 120,
                cooldownMinutesAfterWeekBreach: 240,
                strategyTimezone: "UTC",
            },
            existing: {
                cooldownActive: true,
                cooldownReason: "day_drawdown",
                cooldownStartedAt: Date.parse("2026-04-17T12:00:00.000Z"),
                cooldownExpiresAt: Date.parse("2026-04-17T15:00:00.000Z"),
            },
        })

        expect(result.cooldown.expired).toBe(true)
        expect(result.cooldown.active).toBe(false)
        expect(result.safetyState).toBe("healthy")
    })

    it("blocks same-instrument re-entry after forced-exit clusters and still allows risk reduction", () => {
        const now = Date.parse("2026-04-17T14:30:00.000Z")
        const result = computeRiskGovernanceState({
            now,
            orders: [
                closeOrder({
                    instrument: "BTC-USDT-SWAP",
                    updatedAt: Date.parse("2026-04-17T10:00:00.000Z"),
                    entryPrice: 100,
                    closePrice: 95,
                    filledQuantity: 5,
                    positionSide: "long",
                    forcedExit: true,
                }),
                closeOrder({
                    instrument: "BTC-USDT-SWAP",
                    updatedAt: Date.parse("2026-04-17T12:00:00.000Z"),
                    entryPrice: 96,
                    closePrice: 92,
                    filledQuantity: 5,
                    positionSide: "long",
                    forcedExit: true,
                }),
            ],
            faults: [],
            policy: {
                cooldownMinutesAfterDayBreach: 180,
                cooldownMinutesAfterWeekBreach: 240,
                strategyTimezone: "UTC",
            },
        })

        expect(result.safetyState).toBe("cooldown")
        expect(result.forcedExitClusterInstruments).toEqual(["BTC-USDT-SWAP"])

        const validator = createStrategySafetyValidator({
            safetyState: result.safetyState,
            blockedInstruments: new Set(result.blockedInstruments),
        })

        expect(validator(entryIntent(), {}, account, noPositions).allowed).toBe(false)

        const closeIntent: OrderIntent = {
            ...entryIntent(),
            side: "sell",
            metadata: {
                action: "close",
            },
        }

        expect(validator(closeIntent, {}, account, noPositions).allowed).toBe(true)
    })

    it("holds Friday-style churn blocked across repeated 30-minute cycles when faults remain unresolved", () => {
        const policy = {
            cooldownMinutesAfterDayBreach: 180,
            cooldownMinutesAfterWeekBreach: 240,
            strategyTimezone: "UTC",
        }
        const orders: RiskGovernanceOrderRecord[] = [
            closeOrder({
                instrument: "XAUUSD",
                updatedAt: Date.parse("2026-04-17T09:00:00.000Z"),
                entryPrice: 3400,
                closePrice: 3380,
                filledQuantity: 1,
                positionSide: "long",
                forcedExit: true,
            }),
            closeOrder({
                instrument: "XAUUSD",
                updatedAt: Date.parse("2026-04-17T11:00:00.000Z"),
                entryPrice: 3390,
                closePrice: 3375,
                filledQuantity: 1,
                positionSide: "long",
                forcedExit: true,
            }),
        ]

        const faults = [
            {
                instrument: "XAUUSD",
                blocked: true,
                resolvedAt: undefined,
            },
        ]

        const first = computeRiskGovernanceState({
            now: Date.parse("2026-04-17T15:30:00.000Z"),
            orders,
            faults,
            policy,
        })
        const second = computeRiskGovernanceState({
            now: Date.parse("2026-04-17T16:00:00.000Z"),
            orders,
            faults,
            policy,
            existing: {
                cooldownActive: first.cooldown.active,
                cooldownReason: first.cooldown.reason,
                cooldownStartedAt: first.cooldown.startedAt,
                cooldownExpiresAt: first.cooldown.expiresAt,
                lastBreachReason: first.lastBreachReason,
            },
        })
        const third = computeRiskGovernanceState({
            now: Date.parse("2026-04-17T16:30:00.000Z"),
            orders,
            faults,
            policy,
            existing: {
                cooldownActive: second.cooldown.active,
                cooldownReason: second.cooldown.reason,
                cooldownStartedAt: second.cooldown.startedAt,
                cooldownExpiresAt: second.cooldown.expiresAt,
                lastBreachReason: second.lastBreachReason,
            },
        })

        for (const cycle of [first, second, third]) {
            expect(cycle.safetyState).toBe("cooldown")
            expect(cycle.blockedInstruments).toContain("XAUUSD")
            const validator = createStrategySafetyValidator({
                safetyState: cycle.safetyState,
                blockedInstruments: new Set(cycle.blockedInstruments),
            })
            expect(validator(entryIntent("XAUUSD"), {}, account, noPositions).allowed).toBe(false)
        }
    })

    it("falls back to UTC windows when strategy timezone is invalid", () => {
        const timestamp = Date.parse("2026-04-17T14:00:00.000Z")
        const utc = resolveRiskWindowStarts(timestamp, "UTC")
        const invalid = resolveRiskWindowStarts(timestamp, "Invalid/Timezone")

        expect(invalid).toEqual(utc)
    })

    it("computes recent-trade digest from provider-truth close history", () => {
        const digest = computeRecentTradeDigest({
            timestamp: Date.parse("2026-04-17T14:00:00.000Z"),
            timezone: "UTC",
            orders: [
                {
                    action: "entry",
                    status: "filled",
                    instrument: "BTC-USDT-SWAP",
                    updatedAt: Date.parse("2026-04-17T09:00:00.000Z"),
                    filledQuantity: 1,
                    intent: {
                        metadata: {},
                    },
                },
                closeOrder({
                    instrument: "BTC-USDT-SWAP",
                    updatedAt: Date.parse("2026-04-17T10:00:00.000Z"),
                    entryPrice: 100,
                    closePrice: 110,
                    filledQuantity: 1,
                    positionSide: "long",
                }),
                closeOrder({
                    instrument: "ETH-USDT-SWAP",
                    updatedAt: Date.parse("2026-04-17T11:00:00.000Z"),
                    entryPrice: 200,
                    closePrice: 190,
                    filledQuantity: 1,
                    positionSide: "long",
                    forcedExit: true,
                }),
                {
                    action: "entry",
                    status: "rejected",
                    instrument: "ETH-USDT-SWAP",
                    updatedAt: Date.parse("2026-04-17T12:00:00.000Z"),
                    filledQuantity: 0,
                    intent: {
                        metadata: {},
                    },
                },
            ],
        })

        expect(digest.dayEntries).toBe(2)
        expect(digest.dayCloses).toBe(2)
        expect(digest.dayForcedExits).toBe(1)
        expect(digest.dayRejectedOrTerminal).toBe(1)
        expect(digest.weekRealizedPnl).toBe(0)
        expect(digest.closeOutStreakDirection).toBe("loss")
        expect(digest.closeOutStreakCount).toBe(1)
    })
})

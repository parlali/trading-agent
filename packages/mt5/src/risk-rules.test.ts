import { afterEach, describe, expect, it } from "vitest"
import {
    MT5_POLICY_DEFAULTS,
    validateIntent,
    type AccountState,
    type OrderIntent,
    type Position,
} from "@valiq-trading/core"
import { mt5RiskValidators } from "./risk-rules"

const account: AccountState = {
    balance: 10_000,
    equity: 10_000,
    buyingPower: 10_000,
    marginUsed: 0,
    marginAvailable: 10_000,
    openPnl: 0,
    dayPnl: 0,
}

const positions: Position[] = []
const realDateNow = Date.now
const minRiskRewardValidator = mt5RiskValidators[1]!
const policy = {
    ...MT5_POLICY_DEFAULTS,
    minRiskReward: 2,
}

function entryIntent(impliedRR: number): OrderIntent {
    return {
        instrument: "XAUUSD",
        side: "buy",
        quantity: 1,
        orderType: "market",
        timeInForce: "gtc",
        metadata: {
            action: "entry",
            impliedRR,
        },
    }
}

function pricedEntryIntent(metadata: Record<string, unknown> = {}): OrderIntent {
    return {
        instrument: "XAUUSD",
        side: "buy",
        quantity: 1,
        orderType: "market",
        timeInForce: "gtc",
        metadata: {
            action: "entry",
            estimatedPrice: 100,
            stopLoss: 98,
            takeProfit: 110,
            absoluteSpread: 1,
            ...metadata,
        },
    }
}

function atUtc(time: string): void {
    Date.now = () => new Date(`2026-07-01T${time}:00Z`).getTime()
}

afterEach(() => {
    Date.now = realDateNow
})

describe("mt5 risk gate telemetry", () => {
    it("records observed risk-reward against the minimum threshold", () => {
        const rejected = minRiskRewardValidator(entryIntent(1), policy, account, positions)
        const allowed = minRiskRewardValidator(entryIntent(3), policy, account, positions)

        expect(rejected.allowed).toBe(false)
        expect(rejected.gateEvaluations).toEqual([{
            gateKey: "mt5.minRiskReward",
            observed: 1,
            threshold: 2,
            margin: -0.5,
        }])

        expect(allowed.allowed).toBe(true)
        expect(allowed.gateEvaluations).toEqual([{
            gateKey: "mt5.minRiskReward",
            observed: 3,
            threshold: 2,
            margin: 0.5,
        }])
    })

    it("enforces stop distance clearing the current spread only when policy opts in", () => {
        atUtc("12:00")
        const ungatedPolicy = {
            ...MT5_POLICY_DEFAULTS,
            tradingHours: { start: "00:00", end: "23:59", timezone: "UTC" },
        }
        const gatedPolicy = {
            ...ungatedPolicy,
            minStopDistanceSpreadMultiple: 4,
        }

        const rejected = validateIntent(
            pricedEntryIntent({ stopLoss: 98 }),
            gatedPolicy,
            account,
            positions,
            mt5RiskValidators
        )
        const allowed = validateIntent(
            pricedEntryIntent({ stopLoss: 95 }),
            gatedPolicy,
            account,
            positions,
            mt5RiskValidators
        )
        const absentPolicyAllowed = validateIntent(
            pricedEntryIntent({ stopLoss: 98 }),
            ungatedPolicy,
            account,
            positions,
            mt5RiskValidators
        )
        const missingSpreadRejected = validateIntent(
            pricedEntryIntent({ stopLoss: 95, absoluteSpread: undefined }),
            gatedPolicy,
            account,
            positions,
            mt5RiskValidators
        )

        expect(rejected.allowed).toBe(false)
        expect(rejected.reason).toContain("2.00x current spread")
        expect(rejected.reason).toContain("4x")
        expect(rejected.gateEvaluations).toContainEqual({
            gateKey: "mt5.minStopDistanceSpreadMultiple",
            observed: 2,
            threshold: 4,
            margin: -0.5,
        })

        expect(allowed.allowed).toBe(true)
        expect(allowed.gateEvaluations).toContainEqual({
            gateKey: "mt5.minStopDistanceSpreadMultiple",
            observed: 5,
            threshold: 4,
            margin: 0.25,
        })
        expect(absentPolicyAllowed.allowed).toBe(true)
        expect(missingSpreadRejected.allowed).toBe(false)
        expect(missingSpreadRejected.reason).toContain("cannot verify stop clearance")
    })

    it("rejects MT5 entries inside the configured session-end cutoff", () => {
        const ungatedPolicy = {
            ...MT5_POLICY_DEFAULTS,
            tradingHours: { start: "07:00", end: "21:00", timezone: "UTC" },
        }
        const gatedPolicy = {
            ...ungatedPolicy,
            entryCutoffMinutesBeforeSessionEnd: 30,
        }

        atUtc("20:50")
        const rejected = validateIntent(
            pricedEntryIntent({ stopLoss: 95 }),
            gatedPolicy,
            account,
            positions,
            mt5RiskValidators
        )
        const absentPolicyAllowed = validateIntent(
            pricedEntryIntent({ stopLoss: 95 }),
            ungatedPolicy,
            account,
            positions,
            mt5RiskValidators
        )

        atUtc("20:15")
        const allowed = validateIntent(
            pricedEntryIntent({ stopLoss: 95 }),
            gatedPolicy,
            account,
            positions,
            mt5RiskValidators
        )

        expect(rejected.allowed).toBe(false)
        expect(rejected.reason).toContain("10 minutes remain")
        expect(rejected.reason).toContain("cutoff is 30 minutes")
        expect(rejected.gateEvaluations).toContainEqual({
            gateKey: "mt5.entryCutoffMinutesBeforeSessionEnd",
            observed: 10,
            threshold: 30,
            margin: -0.6666666666666666,
        })
        expect(allowed.allowed).toBe(true)
        expect(allowed.gateEvaluations).toContainEqual({
            gateKey: "mt5.entryCutoffMinutesBeforeSessionEnd",
            observed: 45,
            threshold: 30,
            margin: 0.5,
        })
        expect(absentPolicyAllowed.allowed).toBe(true)
    })
})

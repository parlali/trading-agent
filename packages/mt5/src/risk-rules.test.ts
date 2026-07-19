import { describe, expect, it } from "vitest"
import {
    MT5_POLICY_DEFAULTS,
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
})

import { describe, expect, it } from "vitest"
import type { OrderIntent, Position, AccountState } from "@valiq-trading/core"
import { alpacaRiskValidators } from "./risk-rules"

const structureValidator = alpacaRiskValidators[0]!

const accountState: AccountState = {
    balance: 10_000,
    equity: 10_000,
    buyingPower: 10_000,
    marginUsed: 0,
    marginAvailable: 10_000,
    openPnl: 0,
    dayPnl: 0,
}

const positions: Position[] = []

function validate(intent: OrderIntent) {
    return structureValidator(intent, {}, accountState, positions)
}

describe("alpaca structure validator", () => {
    it("accepts 4-leg iron condor credit entries", () => {
        const result = validate({
            instrument: "SPY",
            side: "sell",
            quantity: 1,
            orderType: "limit",
            limitPrice: 1.2,
            timeInForce: "day",
            legs: [
                {
                    instrument: "SPY260417C00550000",
                    side: "sell_to_open",
                    quantity: 1,
                },
                {
                    instrument: "SPY260417C00555000",
                    side: "buy_to_open",
                    quantity: 1,
                },
                {
                    instrument: "SPY260417P00500000",
                    side: "sell_to_open",
                    quantity: 1,
                },
                {
                    instrument: "SPY260417P00495000",
                    side: "buy_to_open",
                    quantity: 1,
                },
            ],
        })

        expect(result.allowed).toBe(true)
        expect(result.adjustedIntent?.instrument.startsWith("IC:SPY:2026-04-17:")).toBe(true)
        expect(result.adjustedIntent?.metadata).toMatchObject({
            structureType: "iron_condor",
            underlying: "SPY",
            expiration: "2026-04-17",
        })
    })

    it("accepts 2-leg bull put credit entries", () => {
        const result = validate({
            instrument: "SPY",
            side: "sell",
            quantity: 1,
            orderType: "limit",
            limitPrice: 0.85,
            timeInForce: "day",
            legs: [
                {
                    instrument: "SPY260417P00500000",
                    side: "sell_to_open",
                    quantity: 1,
                },
                {
                    instrument: "SPY260417P00495000",
                    side: "buy_to_open",
                    quantity: 1,
                },
            ],
        })

        expect(result.allowed).toBe(true)
        expect(result.adjustedIntent?.instrument.startsWith("VS:BULL_PUT_CREDIT:SPY:2026-04-17:")).toBe(true)
        expect(result.adjustedIntent?.metadata).toMatchObject({
            structureType: "credit_vertical",
            verticalSpreadType: "bull_put_credit",
            underlying: "SPY",
            expiration: "2026-04-17",
        })
    })

    it("accepts 2-leg credit vertical closes and normalizes top-level side to buy", () => {
        const result = validate({
            instrument: "SPY",
            side: "buy",
            quantity: 1,
            orderType: "limit",
            limitPrice: 0.35,
            timeInForce: "day",
            metadata: {
                action: "close",
            },
            legs: [
                {
                    instrument: "SPY260417C00550000",
                    side: "buy_to_close",
                    quantity: 1,
                },
                {
                    instrument: "SPY260417C00555000",
                    side: "sell_to_close",
                    quantity: 1,
                },
            ],
        })

        expect(result.allowed).toBe(true)
        expect(result.adjustedIntent?.side).toBe("buy")
        expect(result.adjustedIntent?.metadata).toMatchObject({
            action: "close",
            structureType: "credit_vertical",
            verticalSpreadType: "bear_call_credit",
        })
    })

    it("rejects non-2/4-leg structures", () => {
        const result = validate({
            instrument: "SPY",
            side: "sell",
            quantity: 1,
            orderType: "limit",
            limitPrice: 0.45,
            timeInForce: "day",
            legs: [
                {
                    instrument: "SPY260417P00500000",
                    side: "sell_to_open",
                    quantity: 1,
                },
            ],
        })

        expect(result.allowed).toBe(false)
        expect(result.reason).toContain("2 or 4")
    })
})

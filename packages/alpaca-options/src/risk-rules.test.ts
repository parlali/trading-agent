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

const maxLossPolicy = {
    llm: {
        provider: "codex",
        model: "gpt-5.5",
        authMode: "chatgpt",
    },
    maxLossPerPlay: 150,
}

function validate(intent: OrderIntent) {
    return structureValidator(intent, {}, accountState, positions)
}

describe("alpaca structure validator", () => {
    it("accepts Alpaca credit entry structures and canonicalizes their instruments", () => {
        const cases = [
            {
                intent: {
                    instrument: "SPY",
                    side: "sell" as const,
                    quantity: 1,
                    orderType: "limit" as const,
                    limitPrice: 1.2,
                    timeInForce: "day" as const,
                    legs: [
                        {
                            instrument: "SPY260417C00550000",
                            side: "sell_to_open" as const,
                            quantity: 1,
                        },
                        {
                            instrument: "SPY260417C00555000",
                            side: "buy_to_open" as const,
                            quantity: 1,
                        },
                        {
                            instrument: "SPY260417P00500000",
                            side: "sell_to_open" as const,
                            quantity: 1,
                        },
                        {
                            instrument: "SPY260417P00495000",
                            side: "buy_to_open" as const,
                            quantity: 1,
                        },
                    ],
                },
                instrumentPrefix: "IC:SPY:2026-04-17:",
                metadata: {
                    structureType: "iron_condor",
                    underlying: "SPY",
                    expiration: "2026-04-17",
                },
            },
            {
                intent: {
                    instrument: "SPY",
                    side: "sell" as const,
                    quantity: 1,
                    orderType: "limit" as const,
                    limitPrice: 0.85,
                    timeInForce: "day" as const,
                    legs: [
                        {
                            instrument: "SPY260417P00500000",
                            side: "sell_to_open" as const,
                            quantity: 1,
                        },
                        {
                            instrument: "SPY260417P00495000",
                            side: "buy_to_open" as const,
                            quantity: 1,
                        },
                    ],
                },
                instrumentPrefix: "VS:BULL_PUT_CREDIT:SPY:2026-04-17:",
                metadata: {
                    structureType: "credit_vertical",
                    verticalSpreadType: "bull_put_credit",
                    underlying: "SPY",
                    expiration: "2026-04-17",
                },
            },
        ]

        for (const testCase of cases) {
            const result = validate(testCase.intent)

            expect(result.allowed).toBe(true)
            expect(result.adjustedIntent?.instrument.startsWith(testCase.instrumentPrefix)).toBe(true)
            expect(result.adjustedIntent?.metadata).toMatchObject(testCase.metadata)
        }
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

    it("nets the credit received when enforcing max loss per play", () => {
        const maxLossValidator = alpacaRiskValidators[1]!
        const nvdaWideStrikesIntent: OrderIntent = {
            instrument: "NVDA",
            side: "sell",
            quantity: 1,
            orderType: "limit",
            limitPrice: 1.1,
            timeInForce: "day",
            legs: [
                {
                    instrument: "NVDA260717C00212500",
                    side: "sell_to_open",
                    quantity: 1,
                },
                {
                    instrument: "NVDA260717C00215000",
                    side: "buy_to_open",
                    quantity: 1,
                },
                {
                    instrument: "NVDA260717P00205000",
                    side: "sell_to_open",
                    quantity: 1,
                },
                {
                    instrument: "NVDA260717P00202500",
                    side: "buy_to_open",
                    quantity: 1,
                },
            ],
        }

        const allowed = maxLossValidator(
            nvdaWideStrikesIntent,
            maxLossPolicy,
            accountState,
            positions
        )
        expect(allowed.allowed).toBe(true)

        const thinCredit = maxLossValidator(
            { ...nvdaWideStrikesIntent, limitPrice: 0.5 },
            maxLossPolicy,
            accountState,
            positions
        )
        expect(thinCredit.allowed).toBe(false)
        expect(thinCredit.reason).toContain("max loss 200")
    })

    it("never blocks closes on max loss per play", () => {
        const maxLossValidator = alpacaRiskValidators[1]!
        const result = maxLossValidator(
            {
                instrument: "NVDA",
                side: "buy",
                quantity: 1,
                orderType: "limit",
                limitPrice: 0.4,
                timeInForce: "day",
                metadata: {
                    action: "close",
                },
                legs: [
                    {
                        instrument: "NVDA260717C00212500",
                        side: "buy_to_close",
                        quantity: 1,
                    },
                    {
                        instrument: "NVDA260717C00215000",
                        side: "sell_to_close",
                        quantity: 1,
                    },
                ],
            },
            maxLossPolicy,
            accountState,
            positions
        )

        expect(result.allowed).toBe(true)
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

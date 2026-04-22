import { describe, expect, it } from "vitest"
import { createMT5SpreadContextLine, resolveMT5NormalizedSpread, toMT5MarketSnapshot } from "./market-context.ts"

describe("MT5 market context spread normalization", () => {
    it("keeps forex spreads in pips", () => {
        const spread = resolveMT5NormalizedSpread({
            symbol: "EURUSD",
            digits: 5,
            point: 0.00001,
            pipSize: 0.0001,
            tickValue: 1,
            contractSize: 100000,
            currency: "USD",
            description: "EURUSD",
            spread: 10,
            volumeMin: 0.01,
            volumeMax: 100,
            volumeStep: 0.01,
            fillingMode: 0,
            bid: 1.1000,
            ask: 1.1001,
        })

        expect(spread.unit).toBe("pips")
        expect(spread.value).toBeCloseTo(1)
        expect(spread.normal).toBe(1)
    })

    it("describes US30 spreads in points instead of pips", () => {
        const snapshot = toMT5MarketSnapshot({
            symbol: "US30",
            digits: 1,
            point: 0.1,
            pipSize: 0.1,
            tickValue: 1,
            contractSize: 1,
            currency: "USD",
            description: "US30",
            spread: 70,
            volumeMin: 0.1,
            volumeMax: 100,
            volumeStep: 0.1,
            fillingMode: 0,
            bid: 39000.0,
            ask: 39007.0,
        })

        expect(snapshot.spreadUnit).toBe("points")
        expect(snapshot.spread).toBeCloseTo(70)
        expect(snapshot.normalSpread).toBe(20)
        expect(createMT5SpreadContextLine([snapshot])).toBe(
            "Current spreads: US30 70 points (normal ~20)"
        )
    })
})

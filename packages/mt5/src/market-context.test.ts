import { describe, expect, it } from "vitest"
import {
    assessExecutionCost,
    resolveExecutionCostMetrics,
    type ExecutionCostAssessment,
} from "@valiq-trading/core"
import {
    createMT5SpreadContextLine,
    resolveMT5NormalizedSpread,
    toMT5MarketSnapshot,
} from "./market-context.ts"

function createAssessment(args: {
    instrument: string
    bestBid: number
    bestAsk: number
    nativeSpread: number
    nativeSpreadUnit: "pips" | "points"
    baselineNativeSpread: number
    baselineBps: number
}): ExecutionCostAssessment {
    const metrics = resolveExecutionCostMetrics({
        app: "mt5",
        instrument: args.instrument,
        instrumentClass: args.instrument === "US30" ? "index" : "fx",
        capturedAt: Date.UTC(2026, 3, 23, 14, 0, 0),
        bestBid: args.bestBid,
        bestAsk: args.bestAsk,
        midpoint: (args.bestBid + args.bestAsk) / 2,
        referencePrice: (args.bestBid + args.bestAsk) / 2,
        absoluteSpread: Math.max(args.bestAsk - args.bestBid, 0),
        nativeSpread: args.nativeSpread,
        nativeSpreadUnit: args.nativeSpreadUnit,
    })

    return assessExecutionCost(metrics, {
        app: "mt5",
        instrument: args.instrument,
        instrumentClass: args.instrument === "US30" ? "index" : "fx",
        regimeKey: metrics.regimeKey,
        nativeSpreadUnit: args.nativeSpreadUnit,
        sampleCount: 12,
        source: "rolling_observed",
        lastObservedAt: metrics.capturedAt,
        nativeSpread: args.baselineNativeSpread,
        absoluteSpread: args.baselineNativeSpread,
        spreadBps: args.baselineBps,
    })
}

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
            bid: 1.1,
            ask: 1.1001,
        })

        expect(spread.unit).toBe("pips")
        expect(spread.value).toBeCloseTo(1)
    })

    it("describes US30 spreads in points with canonical execution-cost context", () => {
        const executionCost = createAssessment({
            instrument: "US30",
            bestBid: 39000,
            bestAsk: 39007,
            nativeSpread: 70,
            nativeSpreadUnit: "points",
            baselineNativeSpread: 20,
            baselineBps: 5.13,
        })
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
            bid: 39000,
            ask: 39007,
        }, executionCost)
        const contextLine = createMT5SpreadContextLine([snapshot])

        expect(snapshot.spreadUnit).toBe("points")
        expect(snapshot.spread).toBeCloseTo(70)
        expect(contextLine).toContain("Current MT5 execution context:")
        expect(contextLine).toContain("US30 70.0 points")
        expect(contextLine).toContain("status NORMAL")
    })
})

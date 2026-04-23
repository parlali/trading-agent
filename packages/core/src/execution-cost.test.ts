import { describe, expect, it } from "vitest"
import {
    ExecutionCostTracker,
    assessExecutionCost,
    resolveExecutionCostMetrics,
} from "./execution-cost.ts"

describe("Execution cost assessment", () => {
    it("blocks when live liquidity is missing at executable size", () => {
        const metrics = resolveExecutionCostMetrics({
            app: "polymarket",
            instrument: "token-yes",
            instrumentClass: "prediction_market",
            capturedAt: Date.UTC(2026, 3, 23, 14, 0, 0),
            bestBid: 0.41,
            bestAsk: 0.59,
            midpoint: 0.5,
            referencePrice: 0.5,
            absoluteSpread: 0.18,
            nativeSpread: 0.18,
            nativeSpreadUnit: "probability",
            liquidityWarning: true,
        })

        const assessment = assessExecutionCost(metrics)

        expect(assessment.status).toBe("blocked")
        expect(assessment.blockNewEntries).toBe(true)
    })

    it("uses burst-observed baselines before the rolling baseline is warm", () => {
        const tracker = new ExecutionCostTracker()
        const capturedAt = Date.UTC(2026, 3, 23, 14, 0, 0)
        const assessment = tracker.assessSnapshots([
            {
                app: "okx-swap",
                instrument: "BTC-USDT-SWAP",
                instrumentClass: "perpetual_swap",
                capturedAt,
                bestBid: 100,
                bestAsk: 100.3,
                midpoint: 100.15,
                referencePrice: 100.15,
                absoluteSpread: 0.3,
                nativeSpread: 0.3,
                nativeSpreadUnit: "price",
            },
            {
                app: "okx-swap",
                instrument: "BTC-USDT-SWAP",
                instrumentClass: "perpetual_swap",
                capturedAt: capturedAt + 1,
                bestBid: 100,
                bestAsk: 100.1,
                midpoint: 100.05,
                referencePrice: 100.05,
                absoluteSpread: 0.1,
                nativeSpread: 0.1,
                nativeSpreadUnit: "price",
            },
            {
                app: "okx-swap",
                instrument: "BTC-USDT-SWAP",
                instrumentClass: "perpetual_swap",
                capturedAt: capturedAt + 2,
                bestBid: 100,
                bestAsk: 100.1,
                midpoint: 100.05,
                referencePrice: 100.05,
                absoluteSpread: 0.1,
                nativeSpread: 0.1,
                nativeSpreadUnit: "price",
            },
        ])

        expect(assessment.baseline?.source).toBe("burst_observed")
        expect(assessment.ratioToBaseline).toBeGreaterThan(2)
        expect(assessment.status).toBe("blocked")
        expect(assessment.blockNewEntries).toBe(true)
    })

    it("normalizes percent and bps for probability-priced markets", () => {
        const metrics = resolveExecutionCostMetrics({
            app: "polymarket",
            instrument: "token-yes",
            instrumentClass: "prediction_market",
            capturedAt: Date.UTC(2026, 3, 23, 14, 0, 0),
            bestBid: 0.51,
            bestAsk: 0.53,
            midpoint: 0.52,
            referencePrice: 0.52,
            absoluteSpread: 0.02,
            nativeSpread: 0.02,
            nativeSpreadUnit: "probability",
        })

        expect(metrics.spreadPercent).toBeCloseTo(3.846153846, 6)
        expect(metrics.spreadBps).toBeCloseTo(384.6153846, 4)
    })
})

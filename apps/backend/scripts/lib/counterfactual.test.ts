import { describe, expect, it } from "vitest"
import {
    resolveCounterfactualEntry,
    resolveBlockedCounterfactual,
    resolveDeclinedCounterfactual,
    summarizeCounterfactualRows,
    buildMT5SelfSampledPriceSeries,
    parsePMForecastLine,
    parsePMResolvedLine,
    computeBrierScore,
    buildPMLogRow,
    buildOptionsRealizationRow,
    type CounterfactualPriceSeries,
} from "./counterfactual"

describe("counterfactual ledger resolution", () => {
    it("resolves a clean take-profit path", () => {
        const row = resolveCounterfactualEntry({
            runId: "run-1",
            book: "book",
            kind: "unfilled",
            instrument: "BTC-USDT-SWAP",
            direction: "long",
            orderType: "limit",
            entryPx: 100,
            stopLoss: 95,
            takeProfit: 110,
            proposedAt: 0,
            fillDeadlineAt: 1_000,
            horizonExitAt: 10_000,
            priceSeries: series([
                sample(1_000, 101, 99, 100),
                sample(2_000, 111, 101, 110),
            ]),
        })

        expect(row.resolution).toBe("tp")
        expect(row.exitPx).toBe(110)
        expect(row.rMultiple).toBe(2)
        expect(row.conservativeFlag).toBe(false)
    })

    it("resolves a clean stop-loss path", () => {
        const row = resolveCounterfactualEntry({
            runId: "run-2",
            book: "book",
            kind: "unfilled",
            instrument: "BTC-USDT-SWAP",
            direction: "short",
            orderType: "limit",
            entryPx: 100,
            stopLoss: 105,
            takeProfit: 90,
            proposedAt: 0,
            fillDeadlineAt: 1_000,
            horizonExitAt: 10_000,
            priceSeries: series([
                sample(1_000, 101, 99, 100),
                sample(2_000, 106, 98, 105),
            ]),
        })

        expect(row.resolution).toBe("sl")
        expect(row.exitPx).toBe(105)
        expect(row.rMultiple).toBe(-1)
        expect(row.conservativeFlag).toBe(false)
    })

    it("scores an ambiguous bar as stop-loss first", () => {
        const row = resolveCounterfactualEntry({
            runId: "run-3",
            book: "book",
            kind: "unfilled",
            instrument: "BTC-USDT-SWAP",
            direction: "long",
            orderType: "limit",
            entryPx: 100,
            stopLoss: 95,
            takeProfit: 105,
            proposedAt: 0,
            fillDeadlineAt: 1_000,
            horizonExitAt: 10_000,
            priceSeries: series([
                sample(1_000, 101, 99, 100),
                sample(2_000, 106, 94, 100),
            ]),
        })

        expect(row.resolution).toBe("sl")
        expect(row.exitPx).toBe(95)
        expect(row.rMultiple).toBe(-1)
        expect(row.conservativeFlag).toBe(true)
    })

    it("leaves an untouched limit entry unfilled", () => {
        const row = resolveCounterfactualEntry({
            runId: "run-4",
            book: "book",
            kind: "unfilled",
            instrument: "BTC-USDT-SWAP",
            direction: "long",
            orderType: "limit",
            entryPx: 100,
            stopLoss: 95,
            takeProfit: 110,
            proposedAt: 0,
            fillDeadlineAt: 2_000,
            horizonExitAt: 10_000,
            priceSeries: series([
                sample(1_000, 112, 101, 108),
                sample(2_000, 113, 102, 109),
                sample(3_000, 99, 94, 96),
            ]),
        })

        expect(row.resolution).toBe("unfilled")
        expect(row.rMultiple).toBeUndefined()
        expect(row.conservativeFlag).toBe(false)
    })

    it("marks an unparseable directional forecast unresolved", () => {
        const row = resolveDeclinedCounterfactual({
            runId: "run-5",
            book: "book",
            instrument: "GBPUSD",
            runStartedAt: 0,
            decisionRecord: {
                decision: "no_trade",
                forecast: {
                    direction: "long",
                    expectedMove: "stale",
                    invalidation: "Lose the breakout",
                    horizon: "30m",
                },
            },
            priceSeries: series([
                sample(1_000, 1.3, 1.29, 1.295),
            ]),
        })

        expect(row?.resolution).toBe("unresolvable")
        expect(row?.reason).toContain("not parseable")
    })

    it("classifies effective trade_blocked decisions as blocked instead of declined or unfilled", () => {
        const decisionRecord = {
            decision: "no_trade" as const,
            effectiveDecision: "trade_blocked" as const,
            forecast: {
                direction: "long" as const,
                expectedMove: "+1%",
                invalidation: "Break below 99",
                horizon: "30m",
            },
        }
        const blocked = resolveBlockedCounterfactual({
            runId: "run-6",
            book: "book",
            instrument: "GBPUSD",
            decisionRecord,
        })
        const declined = resolveDeclinedCounterfactual({
            runId: "run-6",
            book: "book",
            instrument: "GBPUSD",
            runStartedAt: 0,
            decisionRecord,
            priceSeries: series([
                sample(1_000, 101, 99, 100),
            ]),
        })

        expect(blocked).toMatchObject({
            kind: "blocked",
            resolution: "blocked",
        })
        expect(declined).toBeUndefined()

        const summary = summarizeCounterfactualRows([blocked!])
        expect(summary[0]).toMatchObject({
            blockedCount: 1,
            declinedCount: 0,
            unfilledCount: 0,
        })
    })
})

describe("MT5 US30 self-sampled price series", () => {
    it("builds the same interval structure for US30 as for any other MT5 instrument", () => {
        const rawSamples = [
            { timestamp: 1_000, high: 44_020, low: 43_980, close: 44_000, bid: 43_998, ask: 44_002, source: "MT5-US30:run-1" },
            { timestamp: 2_000, high: 44_080, low: 44_010, close: 44_050, bid: 44_048, ask: 44_052, source: "MT5-US30:run-2" },
            { timestamp: 3_000, high: 44_110, low: 44_040, close: 44_090, bid: 44_088, ask: 44_092, source: "MT5-US30:run-3" },
        ]
        const priceSeries = buildMT5SelfSampledPriceSeries("US30", rawSamples)

        expect(priceSeries.instrument).toBe("US30")
        expect(priceSeries.granularity).toBe("mt5_self_sampled_consecutive_range")
        expect(priceSeries.samples).toHaveLength(2)
        expect(priceSeries.entrySamples).toHaveLength(3)

        const firstInterval = priceSeries.samples[0]
        expect(firstInterval?.high).toBe(Math.max(rawSamples[0]!.high, rawSamples[1]!.high))
        expect(firstInterval?.low).toBe(Math.min(rawSamples[0]!.low, rawSamples[1]!.low))
    })
})

describe("PM Brier score resolution", () => {
    it("parses a PM-Macro FORECAST line and produces a pending row for an unresolved market", () => {
        const line = "FORECAST | fed-funds-rate-cut-sept-2026 | 2026-09-17 | my-p=0.30 | market-p=0.55 | evidence: CME dots signal | verdict-vs-market: disagree"
        const forecast = parsePMForecastLine(line)

        expect(forecast).not.toBeUndefined()
        expect(forecast!.market).toBe("fed-funds-rate-cut-sept-2026")
        expect(forecast!.myP).toBe(0.30)
        expect(forecast!.marketP).toBe(0.55)

        const row = buildPMLogRow({
            runId: "run-pm-1",
            book: "PM-Macro",
            market: forecast!.market,
            myP: forecast!.myP,
            marketP: forecast!.marketP,
        })

        expect(row.kind).toBe("pending")
        expect(row.resolution).toBe("unresolvable")
        expect(row.pmBrierScore).toBeUndefined()
    })

    it("computes Brier score for FOMC resolution: fed-rate-hike-by-july-2026 outcome NO my-p=0.05 market-p=0.27", () => {
        const forecastLine = "FORECAST | fed-rate-hike-by-july-2026 | 2026-07-30 | my-p=0.05 | market-p=0.27 | evidence: FOMC dots, no hike language | verdict-vs-market: disagree"
        const resolvedLine = "RESOLVED | fed-rate-hike-by-july-2026 | outcome=NO | my-last-p=0.05 | market-last-p=0.27"

        const forecast = parsePMForecastLine(forecastLine)
        const resolved = parsePMResolvedLine(resolvedLine)

        expect(forecast).not.toBeUndefined()
        expect(resolved).not.toBeUndefined()
        expect(resolved!.market).toBe("fed-rate-hike-by-july-2026")
        expect(resolved!.outcome).toBe("NO")
        expect(resolved!.myLastP).toBe(0.05)
        expect(resolved!.marketLastP).toBe(0.27)

        const myP = resolved!.myLastP ?? forecast!.myP
        const marketP = resolved!.marketLastP ?? forecast!.marketP
        const modelBrier = computeBrierScore(myP, resolved!.outcome)
        const marketBrier = computeBrierScore(marketP, resolved!.outcome)

        expect(modelBrier).toBeCloseTo(0.0025)
        expect(marketBrier).toBeCloseTo(0.0729)

        const row = buildPMLogRow({
            runId: "run-fomc-resolved",
            book: "PM-Macro",
            market: resolved!.market,
            myP,
            marketP,
            outcome: resolved!.outcome,
            resolvedAt: "2026-07-30T18:00:00.000Z",
        })

        expect(row.kind).toBe("taken")
        expect(row.resolution).toBe("horizon_exit")
        expect(row.pmMarket).toBe("fed-rate-hike-by-july-2026")
        expect(row.pmMyP).toBe(0.05)
        expect(row.pmMarketP).toBe(0.27)
        expect(row.pmOutcome).toBe("NO")
        expect(row.pmBrierScore).toBeCloseTo(0.0025)

        const summary = summarizeCounterfactualRows([row])
        expect(summary[0]?.pmResolvedCount).toBe(1)
        expect(summary[0]?.pmPendingCount).toBe(0)
        expect(summary[0]?.pmBrierAvg).toBeCloseTo(0.0025)
    })
})

describe("options realized-pair resolution", () => {
    it("computes credit percent and credit-to-maxLoss percent from an entry/close pair", () => {
        const row = buildOptionsRealizationRow({
            runId: "run-options-1",
            book: "ALP-SPY",
            instrument: "SPY",
            orderId: "ord-spy-001",
            credit: 0.45,
            debit: 0.18,
            maxLoss: 2.05,
            resolvedAt: "2026-07-28T14:00:00.000Z",
        })

        expect(row.kind).toBe("taken")
        expect(row.resolution).toBe("tp")
        expect(row.optionsCreditPct).toBeCloseTo(60)
        expect(row.optionsCreditToMaxLossPct).toBeCloseTo((0.45 - 0.18) / 2.05 * 100)
    })

    it("marks an options taken row unresolvable when no close order is found", () => {
        const row = buildOptionsRealizationRow({
            runId: "run-options-2",
            book: "ALP-NVDA",
            instrument: "NVDA",
            orderId: "ord-nvda-001",
            credit: 0.55,
        })

        expect(row.kind).toBe("taken")
        expect(row.resolution).toBe("unresolvable")
        expect(row.optionsCreditPct).toBeUndefined()
        expect(row.reason).toContain("close order not found")
    })
})

function series(samples: CounterfactualPriceSeries["samples"]): CounterfactualPriceSeries {
    return {
        instrument: "TEST",
        granularity: "synthetic",
        samples,
        entrySamples: samples,
    }
}

function sample(timestamp: number, high: number, low: number, close: number) {
    return {
        timestamp,
        high,
        low,
        close,
    }
}

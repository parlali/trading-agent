import { describe, expect, it } from "vitest"
import {
    resolveCounterfactualEntry,
    resolveBlockedCounterfactual,
    resolveDeclinedCounterfactual,
    summarizeCounterfactualRows,
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

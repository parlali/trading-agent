import { describe, expect, it } from "vitest"
import { classifyOKXSetups, createOKXSetupClassifierLine } from "./market-context"
import type { OKXMarketSnapshot } from "./market-context"

function snapshot(overrides: Partial<OKXMarketSnapshot> = {}): OKXMarketSnapshot {
    return {
        instrument: "BTC-USDT-SWAP",
        bid: 80_000,
        ask: 80_004,
        markPrice: 80_002,
        fundingRate: 0.00003,
        executionCost: {
            status: "normal",
            blockNewEntries: false,
            summary: "normal spread",
            metrics: {
                app: "okx-swap",
                instrument: "BTC-USDT-SWAP",
                instrumentClass: "perpetual_swap",
                capturedAt: 1,
                regimeKey: "global",
                nativeSpreadUnit: "price",
                liquidityWarning: false,
            },
        },
        ...overrides,
    }
}

describe("OKX setup classifier", () => {
    it("marks ordinary funding as no setup before model research", () => {
        const [classification] = classifyOKXSetups([snapshot()], {
            fundingRateThreshold: 0.00015,
        })

        expect(classification).toMatchObject({
            instrument: "BTC-USDT-SWAP",
            state: "no_setup",
            families: [],
        })
    })

    it("records building or extreme funding as watchlist context without making the trade decision", () => {
        const line = createOKXSetupClassifierLine([
            snapshot({
                fundingRate: 0.00016,
            }),
        ], {
            fundingRateThreshold: 0.00015,
        })

        expect(line).toContain("watchlist")
        expect(line).toContain("funding_crowding_extreme")
        expect(line).toContain("requires price failure")
    })
})

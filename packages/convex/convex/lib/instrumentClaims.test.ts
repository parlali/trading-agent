import { describe, expect, it } from "vitest"
import { getClaimInstrumentsForOrder } from "./instrumentClaims"

describe("getClaimInstrumentsForOrder", () => {
    it("expands multi-leg option orders into parent and leg claim instruments", () => {
        expect(getClaimInstrumentsForOrder(
            "IC:SPY:2026-04-24:SPY260424C00685000|SPY260424C00686000|SPY260424P00672000|SPY260424P00673000",
            {
                legs: [
                    { instrument: "SPY260424P00672000", side: "buy_to_open" },
                    { instrument: "SPY260424P00673000", side: "sell_to_open" },
                    { instrument: "SPY260424C00685000", side: "sell_to_open" },
                    { instrument: "SPY260424C00686000", side: "buy_to_open" },
                ],
            }
        )).toEqual([
            "IC:SPY:2026-04-24:SPY260424C00685000|SPY260424C00686000|SPY260424P00672000|SPY260424P00673000",
            "SPY260424P00672000",
            "SPY260424P00673000",
            "SPY260424C00685000",
            "SPY260424C00686000",
        ])
    })

    it("falls back to the parent instrument for non-leg orders", () => {
        expect(getClaimInstrumentsForOrder("XAUUSD", { quantity: 0.01 })).toEqual(["XAUUSD"])
    })
})

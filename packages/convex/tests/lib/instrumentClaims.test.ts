import { describe, expect, it } from "vitest"
import { getClaimInstrumentsForOrder, getProviderInstrumentClaimAliases } from "../../convex/lib/instrumentClaims"

describe("getClaimInstrumentsForOrder", () => {
    it("expands grouped Alpaca multi-leg claims into parent, raw-leg, and vertical aliases", () => {
        const expectedClaims = [
            "IC:SPY:2026-04-24:SPY260424C00685000|SPY260424C00686000|SPY260424P00672000|SPY260424P00673000",
            "SPY260424C00685000",
            "SPY260424C00686000",
            "SPY260424P00672000",
            "SPY260424P00673000",
            "VS:BEAR_CALL_CREDIT:SPY:2026-04-24:SPY260424C00685000|SPY260424C00686000",
            "VS:BULL_PUT_CREDIT:SPY:2026-04-24:SPY260424P00672000|SPY260424P00673000",
        ]

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
        )).toEqual(expectedClaims)
        expect(getProviderInstrumentClaimAliases(
            "alpaca-options",
            "IC:SPY:2026-04-24:SPY260424C00685000|SPY260424C00686000|SPY260424P00672000|SPY260424P00673000",
        )).toEqual(expectedClaims)
    })
})

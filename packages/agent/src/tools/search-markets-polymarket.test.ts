import { describe, expect, it, vi } from "vitest"
import type { PolymarketVenueAdapter } from "@valiq-trading/polymarket"
import { createPolymarketSearchMarketsTool } from "./search-markets-polymarket"

describe("createPolymarketSearchMarketsTool", () => {
    it("returns a structured resolved-or-not-found note for empty conditionId lookups", async () => {
        const venue = {
            searchMarkets: vi.fn(async () => []),
        } as unknown as PolymarketVenueAdapter
        const tool = createPolymarketSearchMarketsTool(venue)

        const result = await tool.handler({
            conditionId: "resolved-condition",
        })

        expect(result).toEqual({
            markets: [],
            note: "market_resolved_or_not_found",
        })
        expect(venue.searchMarkets).toHaveBeenCalledWith({
            conditionId: "resolved-condition",
            livePriceTokenLimit: undefined,
        })
    })
})

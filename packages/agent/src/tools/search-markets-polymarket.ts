import { z } from "zod"
import type { PolymarketVenueAdapter } from "@valiq-trading/polymarket"
import type { ToolDefinition } from "../tool-registry"
import {
    createToolDefinition,
    searchMarketsParamsSchema,
} from "../tool-contracts"

export function createPolymarketSearchMarketsTool(
    venue: PolymarketVenueAdapter
): ToolDefinition {
    return createToolDefinition({
        name: "search_markets",
        venue: "polymarket",
        handler: async (params) => {
            const validated = params as z.infer<typeof searchMarketsParamsSchema>
            if (!validated.category && !validated.query && !validated.conditionId) {
                throw new Error("search_markets requires category, query, or conditionId")
            }
            if (validated.livePriceTokenLimit !== undefined && validated.includeLivePrices !== true) {
                throw new Error("search_markets livePriceTokenLimit requires includeLivePrices=true")
            }

            const markets = await venue.searchMarkets(validated)
            return { markets }
        },
    })
}

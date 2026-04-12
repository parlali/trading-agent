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
            if (!validated.category && !validated.query && !validated.conditionId && !validated.marketSlug) {
                throw new Error("search_markets requires category, query, conditionId, or marketSlug")
            }

            const markets = await venue.searchMarkets({
                ...validated,
                livePriceTokenLimit: validated.includeLivePrices === true
                    ? validated.livePriceTokenLimit
                    : undefined,
            })
            return { markets }
        },
    })
}

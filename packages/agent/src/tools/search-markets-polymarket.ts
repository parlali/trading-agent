import { z } from "zod"
import type { PolymarketVenueAdapter } from "@valiq-trading/polymarket"
import type { ToolBinding } from "../tool-registry"
import {
    createToolBinding,
    searchMarketsParamsSchema,
} from "../tool-contracts"
import { PolymarketMarketHandleRegistry } from "./polymarket-market-handles"
import { toModelExecutionCostEvidence } from "./tool-result-evidence"

export function createPolymarketSearchMarketsTool(
    venue: PolymarketVenueAdapter,
    handles: PolymarketMarketHandleRegistry = new PolymarketMarketHandleRegistry()
): ToolBinding {
    return createToolBinding({
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
            const registeredMarkets = handles.registerMarkets(markets)
            const modelMarkets = registeredMarkets.map((market) => ({
                ...market,
                tokens: market.tokens.map((token) => ({
                    ...token,
                    executionCost: toModelExecutionCostEvidence(token.executionCost),
                })),
            }))
            return validated.conditionId && registeredMarkets.length === 0
                ? { markets: modelMarkets, note: "market_resolved_or_not_found" }
                : { markets: modelMarkets }
        },
    })
}

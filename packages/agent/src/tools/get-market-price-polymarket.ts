import { z } from "zod"
import type { PolymarketVenueAdapter } from "@valiq-trading/polymarket"
import type { ToolDefinition } from "../tool-registry"
import {
    createToolDefinition,
    polymarketMarketPriceParamsSchema,
} from "../tool-contracts"

export function createPolymarketGetMarketPriceTool(
    venue: PolymarketVenueAdapter
): ToolDefinition {
    return createToolDefinition({
        name: "get_market_price",
        venue: "polymarket",
        handler: async (params) => {
            const validated = params as z.infer<typeof polymarketMarketPriceParamsSchema>
            return await venue.getMarketPrice(validated.tokenId, validated.side)
        },
    })
}

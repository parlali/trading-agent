import { z } from "zod"
import type { PolymarketVenueAdapter } from "@valiq-trading/polymarket"
import type { ToolDefinition } from "../tool-registry"
import {
    createToolDefinition,
    polymarketMarketPriceParamsSchema,
} from "../tool-contracts"
import { PolymarketMarketHandleRegistry } from "./polymarket-market-handles"

export function createPolymarketGetMarketPriceTool(
    venue: PolymarketVenueAdapter,
    handles: PolymarketMarketHandleRegistry = new PolymarketMarketHandleRegistry()
): ToolDefinition {
    return createToolDefinition({
        name: "get_market_price",
        venue: "polymarket",
        handler: async (params) => {
            const validated = params as z.infer<typeof polymarketMarketPriceParamsSchema>
            const token = handles.resolveToken(validated)
            return await venue.getMarketPrice(token.tokenId, validated.side)
        },
    })
}

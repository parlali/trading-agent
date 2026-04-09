import { z } from "zod"
import type { PolymarketVenueAdapter } from "@valiq-trading/polymarket"
import type { ToolDefinition } from "../tool-registry"
import {
    createToolDefinition,
    polymarketOrderBookParamsSchema,
} from "../tool-contracts"

export function createPolymarketGetOrderBookTool(
    venue: PolymarketVenueAdapter
): ToolDefinition {
    return createToolDefinition({
        name: "get_order_book",
        venue: "polymarket",
        handler: async (params) => {
            const validated = params as z.infer<typeof polymarketOrderBookParamsSchema>
            const orderBook = await venue.getOrderBook(validated.tokenId)
            const levels = validated.levels

            return {
                tokenId: validated.tokenId,
                market: orderBook.market,
                timestamp: orderBook.timestamp,
                bids: levels ? orderBook.bids.slice(0, levels) : orderBook.bids,
                asks: levels ? orderBook.asks.slice(0, levels) : orderBook.asks,
            }
        },
    })
}

import { z } from "zod"
import type { PolymarketVenueAdapter } from "@valiq-trading/polymarket"
import type { ToolDefinition } from "../tool-registry"
import {
    createToolDefinition,
    polymarketOrderBookParamsSchema,
} from "../tool-contracts"
import { PolymarketMarketHandleRegistry } from "./polymarket-market-handles"

export function createPolymarketGetOrderBookTool(
    venue: PolymarketVenueAdapter,
    handles: PolymarketMarketHandleRegistry = new PolymarketMarketHandleRegistry()
): ToolDefinition {
    return createToolDefinition({
        name: "get_order_book",
        venue: "polymarket",
        handler: async (params) => {
            const validated = params as z.infer<typeof polymarketOrderBookParamsSchema>
            const token = handles.resolveToken(validated)
            const orderBook = await venue.getOrderBook(token.tokenId)
            const levels = validated.levels

            return {
                tokenId: token.tokenId,
                tokenHandle: token.tokenHandle || undefined,
                market: orderBook.market,
                timestamp: orderBook.timestamp,
                bids: levels ? orderBook.bids.slice(0, levels) : orderBook.bids,
                asks: levels ? orderBook.asks.slice(0, levels) : orderBook.asks,
            }
        },
    })
}

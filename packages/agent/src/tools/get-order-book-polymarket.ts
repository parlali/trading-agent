import { z } from "zod"
import type { PolymarketVenueAdapter } from "@valiq-trading/polymarket"
import type { ToolDefinition } from "../tool-registry"

const paramsSchema = z.object({
    tokenId: z.string(),
    levels: z.number().int().positive().max(50).optional(),
})

export function createPolymarketGetOrderBookTool(
    venue: PolymarketVenueAdapter
): ToolDefinition {
    return {
        name: "get_order_book",
        description: "Fetch the live Polymarket order book for a token. Use this to assess spread and available depth before sizing an order.",
        parameters: paramsSchema,
        jsonSchema: {
            type: "object",
            properties: {
                tokenId: {
                    type: "string",
                    description: "Polymarket token ID",
                },
                levels: {
                    type: "number",
                    description: "Optional number of bid and ask levels to return",
                },
            },
            required: ["tokenId"],
        },
        handler: async (params) => {
            const validated = params as z.infer<typeof paramsSchema>
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
    }
}

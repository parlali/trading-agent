import { z } from "zod"
import type { BinanceVenueAdapter } from "@valiq-trading/binance"
import type { ToolDefinition } from "../tool-registry"

const paramsSchema = z.object({
    symbol: z.string(),
    limit: z.number().int().positive().max(1000).optional(),
})

export function createBinanceGetOrderBookTool(
    venue: BinanceVenueAdapter
): ToolDefinition {
    return {
        name: "get_order_book",
        description: "Fetch the live Binance futures order book for a symbol. Use this to assess depth and likely slippage before sizing larger entries.",
        parameters: paramsSchema,
        jsonSchema: {
            type: "object",
            properties: {
                symbol: {
                    type: "string",
                    description: "Binance futures symbol such as BTCUSDT or ETHUSDT",
                },
                limit: {
                    type: "number",
                    description: "Depth limit passed to Binance",
                },
            },
            required: ["symbol"],
        },
        handler: async (params) => {
            const validated = params as z.infer<typeof paramsSchema>
            return await venue.getOrderBook(validated.symbol, validated.limit)
        },
    }
}

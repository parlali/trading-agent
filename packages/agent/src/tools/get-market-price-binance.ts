import { z } from "zod"
import type { BinanceVenueAdapter } from "@valiq-trading/binance"
import type { ToolDefinition } from "../tool-registry"

const paramsSchema = z.object({
    symbol: z.string(),
})

export function createBinanceGetMarketPriceTool(
    venue: BinanceVenueAdapter
): ToolDefinition {
    return {
        name: "get_market_price",
        description: "Fetch the current Binance futures mark price, index price, best bid, best ask, spread, funding rate, and next funding time for a symbol.",
        parameters: paramsSchema,
        jsonSchema: {
            type: "object",
            properties: {
                symbol: {
                    type: "string",
                    description: "Binance futures symbol such as BTCUSDT or ETHUSDT",
                },
            },
            required: ["symbol"],
        },
        handler: async (params) => {
            const validated = params as z.infer<typeof paramsSchema>
            return await venue.getMarketPrice(validated.symbol)
        },
    }
}

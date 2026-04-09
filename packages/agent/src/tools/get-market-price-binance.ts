import { z } from "zod"
import type { BinanceVenueAdapter } from "@valiq-trading/binance"
import type { ToolDefinition } from "../tool-registry"
import {
    createToolDefinition,
    singleSymbolParamsSchema,
} from "../tool-contracts"

export function createBinanceGetMarketPriceTool(
    venue: BinanceVenueAdapter
): ToolDefinition {
    return createToolDefinition({
        name: "get_market_price",
        venue: "binance-futures",
        handler: async (params) => {
            const validated = params as z.infer<typeof singleSymbolParamsSchema>
            return await venue.getMarketPrice(validated.symbol)
        },
    })
}

import { z } from "zod"
import type { BinanceVenueAdapter } from "@valiq-trading/binance"
import type { ToolDefinition } from "../tool-registry"
import {
    binanceOrderBookParamsSchema,
    createToolDefinition,
} from "../tool-contracts"

export function createBinanceGetOrderBookTool(
    venue: BinanceVenueAdapter
): ToolDefinition {
    return createToolDefinition({
        name: "get_order_book",
        venue: "binance-futures",
        handler: async (params) => {
            const validated = params as z.infer<typeof binanceOrderBookParamsSchema>
            return await venue.getOrderBook(validated.symbol, validated.limit)
        },
    })
}

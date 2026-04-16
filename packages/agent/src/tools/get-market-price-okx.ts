import { z } from "zod"
import type { OKXVenueAdapter } from "@valiq-trading/okx"
import type { ToolDefinition } from "../tool-registry"
import {
    createToolDefinition,
    singleSymbolParamsSchema,
} from "../tool-contracts"

export function createOKXGetMarketPriceTool(
    venue: OKXVenueAdapter
): ToolDefinition {
    return createToolDefinition({
        name: "get_market_price",
        venue: "okx-swap",
        handler: async (params) => {
            const validated = params as z.infer<typeof singleSymbolParamsSchema>
            return await venue.getMarketPrice(validated.symbol)
        },
    })
}

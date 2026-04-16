import { z } from "zod"
import type { OKXVenueAdapter } from "@valiq-trading/okx"
import type { ToolDefinition } from "../tool-registry"
import {
    createToolDefinition,
    okxOrderBookParamsSchema,
} from "../tool-contracts"

export function createOKXGetOrderBookTool(
    venue: OKXVenueAdapter
): ToolDefinition {
    return createToolDefinition({
        name: "get_order_book",
        venue: "okx-swap",
        handler: async (params) => {
            const validated = params as z.infer<typeof okxOrderBookParamsSchema>
            return await venue.getOrderBook(validated.symbol, validated.limit)
        },
    })
}

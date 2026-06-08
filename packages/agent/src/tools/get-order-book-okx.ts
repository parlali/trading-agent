import { z } from "zod"
import type { OKXVenueAdapter } from "@valiq-trading/okx"
import type { ToolBinding } from "../tool-registry"
import {
    createToolBinding,
    okxOrderBookParamsSchema,
} from "../tool-contracts"

export function createOKXGetOrderBookTool(
    venue: OKXVenueAdapter
): ToolBinding {
    return createToolBinding({
        name: "get_order_book",
        venue: "okx-swap",
        handler: async (params) => {
            const validated = params as z.infer<typeof okxOrderBookParamsSchema>
            return await venue.getOrderBook(validated.symbol, validated.limit)
        },
    })
}

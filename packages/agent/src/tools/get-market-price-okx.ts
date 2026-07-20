import { z } from "zod"
import type { OKXVenueAdapter } from "@valiq-trading/okx"
import type { ToolBinding } from "../tool-registry"
import {
    createToolBinding,
    singleSymbolParamsSchema,
} from "../tool-contracts"
import { toModelMarketPriceEvidence } from "./tool-result-evidence"

export function createOKXGetMarketPriceTool(
    venue: OKXVenueAdapter
): ToolBinding {
    return createToolBinding({
        name: "get_market_price",
        venue: "okx-swap",
        handler: async (params) => {
            const validated = params as z.infer<typeof singleSymbolParamsSchema>
            return toModelMarketPriceEvidence(await venue.getMarketPrice(validated.symbol))
        },
    })
}

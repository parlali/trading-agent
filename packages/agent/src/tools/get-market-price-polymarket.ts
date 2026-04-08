import { z } from "zod"
import type { PolymarketVenueAdapter } from "@valiq-trading/polymarket"
import type { ToolDefinition } from "../tool-registry"

const paramsSchema = z.object({
    tokenId: z.string(),
    side: z.enum(["buy", "sell"]).optional(),
})

export function createPolymarketGetMarketPriceTool(
    venue: PolymarketVenueAdapter
): ToolDefinition {
    return {
        name: "get_market_price",
        description: "Fetch the current Polymarket midpoint, best bid, best ask, spread, and optional executable price for a token.",
        parameters: paramsSchema,
        jsonSchema: {
            type: "object",
            properties: {
                tokenId: {
                    type: "string",
                    description: "Polymarket token ID",
                },
                side: {
                    type: "string",
                    enum: ["buy", "sell"],
                    description: "Optional side to include the current executable price",
                },
            },
            required: ["tokenId"],
        },
        handler: async (params) => {
            const validated = params as z.infer<typeof paramsSchema>
            return await venue.getMarketPrice(validated.tokenId, validated.side)
        },
    }
}

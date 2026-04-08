import { z } from "zod"
import type { PolymarketVenueAdapter } from "@valiq-trading/polymarket"
import type { ToolDefinition } from "../tool-registry"

const paramsSchema = z.object({
    query: z.string().optional(),
    conditionId: z.string().optional(),
    limit: z.number().int().positive().max(25).optional(),
})

export function createPolymarketSearchMarketsTool(
    venue: PolymarketVenueAdapter
): ToolDefinition {
    return {
        name: "search_markets",
        description: "Search active Polymarket markets by query or fetch a specific market by condition ID. Returns market metadata plus current token pricing and basic liquidity indicators.",
        parameters: paramsSchema,
        jsonSchema: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Search text matching the question, description, category, or outcomes",
                },
                conditionId: {
                    type: "string",
                    description: "Exact Polymarket condition ID",
                },
                limit: {
                    type: "number",
                    description: "Maximum number of markets to return",
                },
            },
        },
        handler: async (params) => {
            const validated = params as z.infer<typeof paramsSchema>
            if (!validated.query && !validated.conditionId) {
                throw new Error("search_markets requires either query or conditionId")
            }

            const markets = await venue.searchMarkets(validated)
            return { markets }
        },
    }
}

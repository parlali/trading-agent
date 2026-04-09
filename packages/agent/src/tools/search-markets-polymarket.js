import { createToolDefinition, } from "../tool-contracts";
export function createPolymarketSearchMarketsTool(venue) {
    return createToolDefinition({
        name: "search_markets",
        venue: "polymarket",
        handler: async (params) => {
            const validated = params;
            if (!validated.query && !validated.conditionId) {
                throw new Error("search_markets requires either query or conditionId");
            }
            const markets = await venue.searchMarkets(validated);
            return { markets };
        },
    });
}

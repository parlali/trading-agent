import { createToolDefinition, } from "../tool-contracts";
export function createPolymarketGetMarketPriceTool(venue) {
    return createToolDefinition({
        name: "get_market_price",
        venue: "polymarket",
        handler: async (params) => {
            const validated = params;
            return await venue.getMarketPrice(validated.tokenId, validated.side);
        },
    });
}

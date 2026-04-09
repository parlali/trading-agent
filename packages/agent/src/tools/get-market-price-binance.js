import { createToolDefinition, } from "../tool-contracts";
export function createBinanceGetMarketPriceTool(venue) {
    return createToolDefinition({
        name: "get_market_price",
        venue: "binance-futures",
        handler: async (params) => {
            const validated = params;
            return await venue.getMarketPrice(validated.symbol);
        },
    });
}

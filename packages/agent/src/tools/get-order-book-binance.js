import { createToolDefinition, } from "../tool-contracts";
export function createBinanceGetOrderBookTool(venue) {
    return createToolDefinition({
        name: "get_order_book",
        venue: "binance-futures",
        handler: async (params) => {
            const validated = params;
            return await venue.getOrderBook(validated.symbol, validated.limit);
        },
    });
}

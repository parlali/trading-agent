import { createToolDefinition, } from "../tool-contracts";
export function createPolymarketGetOrderBookTool(venue) {
    return createToolDefinition({
        name: "get_order_book",
        venue: "polymarket",
        handler: async (params) => {
            const validated = params;
            const orderBook = await venue.getOrderBook(validated.tokenId);
            const levels = validated.levels;
            return {
                tokenId: validated.tokenId,
                market: orderBook.market,
                timestamp: orderBook.timestamp,
                bids: levels ? orderBook.bids.slice(0, levels) : orderBook.bids,
                asks: levels ? orderBook.asks.slice(0, levels) : orderBook.asks,
            };
        },
    });
}

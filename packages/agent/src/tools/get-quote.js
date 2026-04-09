import { createToolDefinition, } from "../tool-contracts";
export function createAlpacaGetQuoteTool(venue) {
    return createToolDefinition({
        name: "get_quote",
        venue: "alpaca-options",
        handler: async (params) => {
            const validated = params;
            const [quote, snapshot] = await Promise.all([
                venue.getQuote(validated.symbol),
                venue.getEquitySnapshot(validated.symbol),
            ]);
            return {
                symbol: validated.symbol.toUpperCase(),
                bid: quote.bidPrice,
                ask: quote.askPrice,
                lastTradePrice: snapshot.latestTrade?.price,
                timestamp: quote.timestamp ?? snapshot.latestTrade?.timestamp,
                minuteBar: snapshot.minuteBar,
                dailyBar: snapshot.dailyBar,
                prevDailyBar: snapshot.prevDailyBar,
            };
        },
    });
}

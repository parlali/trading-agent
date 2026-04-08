import { z } from "zod"
import type { AlpacaOptionsVenueAdapter } from "@valiq-trading/alpaca-options"
import type { ToolDefinition } from "../tool-registry"

const paramsSchema = z.object({
    symbol: z.string(),
})

export function createAlpacaGetQuoteTool(
    venue: AlpacaOptionsVenueAdapter
): ToolDefinition {
    return {
        name: "get_quote",
        description: "Fetch the latest live Alpaca quote for an equity underlying. Returns current bid, ask, last trade price, minute bar, and timestamps.",
        parameters: paramsSchema,
        jsonSchema: {
            type: "object",
            properties: {
                symbol: {
                    type: "string",
                    description: "Underlying equity symbol such as SPY",
                },
            },
            required: ["symbol"],
        },
        handler: async (params) => {
            const validated = params as z.infer<typeof paramsSchema>
            const [quote, snapshot] = await Promise.all([
                venue.getQuote(validated.symbol),
                venue.getEquitySnapshot(validated.symbol),
            ])

            return {
                symbol: validated.symbol.toUpperCase(),
                bid: quote.bidPrice,
                ask: quote.askPrice,
                lastTradePrice: snapshot.latestTrade?.price,
                timestamp: quote.timestamp ?? snapshot.latestTrade?.timestamp,
                minuteBar: snapshot.minuteBar,
                dailyBar: snapshot.dailyBar,
                prevDailyBar: snapshot.prevDailyBar,
            }
        },
    }
}

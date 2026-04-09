import { z } from "zod"
import type { AlpacaOptionsVenueAdapter } from "@valiq-trading/alpaca-options"
import type { ToolDefinition } from "../tool-registry"
import {
    createToolDefinition,
    singleSymbolParamsSchema,
} from "../tool-contracts"

export function createAlpacaGetQuoteTool(
    venue: AlpacaOptionsVenueAdapter
): ToolDefinition {
    return createToolDefinition({
        name: "get_quote",
        venue: "alpaca-options",
        handler: async (params) => {
            const validated = params as z.infer<typeof singleSymbolParamsSchema>
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
    })
}

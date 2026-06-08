import { z } from "zod"
import type { AlpacaOptionsVenueAdapter } from "@valiq-trading/alpaca-options"
import type { ToolBinding } from "../tool-registry"
import {
    createToolBinding,
    singleSymbolParamsSchema,
} from "../tool-contracts"

export function createAlpacaGetQuoteTool(
    venue: AlpacaOptionsVenueAdapter
): ToolBinding {
    return createToolBinding({
        name: "get_quote",
        venue: "alpaca-options",
        handler: async (params) => {
            const validated = params as z.infer<typeof singleSymbolParamsSchema>
            const [quote, snapshot] = await Promise.all([
                venue.getQuote(validated.symbol),
                venue.getEquitySnapshot(validated.symbol),
            ])
            const executionCost = venue.assessEquityQuoteExecutionCost(validated.symbol, quote)

            return {
                symbol: validated.symbol.toUpperCase(),
                bid: quote.bidPrice,
                ask: quote.askPrice,
                lastTradePrice: snapshot.latestTrade?.price,
                timestamp: quote.timestamp ?? snapshot.latestTrade?.timestamp,
                minuteBar: snapshot.minuteBar,
                dailyBar: snapshot.dailyBar,
                prevDailyBar: snapshot.prevDailyBar,
                executionCost,
            }
        },
    })
}

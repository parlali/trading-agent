import { z } from "zod"
import type { AlpacaOptionsVenueAdapter } from "@valiq-trading/alpaca-options"
import type { ToolDefinition } from "../tool-registry"

const paramsSchema = z.object({
    underlyingSymbol: z.string(),
    expirationDate: z.string().optional(),
    expirationDateFrom: z.string().optional(),
    expirationDateTo: z.string().optional(),
    strikePriceGte: z.number().optional(),
    strikePriceLte: z.number().optional(),
    optionType: z.enum(["call", "put"]).optional(),
    limit: z.number().int().positive().max(1000).optional(),
})

export function createAlpacaGetOptionsChainTool(
    venue: AlpacaOptionsVenueAdapter
): ToolDefinition {
    return {
        name: "get_options_chain",
        description: "Fetch the live Alpaca options chain for an underlying. Returns contracts with current bid/ask, midpoint, latest trade, greeks, implied volatility, and open interest from Alpaca market data.",
        parameters: paramsSchema,
        jsonSchema: {
            type: "object",
            properties: {
                underlyingSymbol: {
                    type: "string",
                    description: "Underlying equity symbol such as SPY",
                },
                expirationDate: {
                    type: "string",
                    description: "Exact expiration date in YYYY-MM-DD format",
                },
                expirationDateFrom: {
                    type: "string",
                    description: "Earliest expiration date in YYYY-MM-DD format",
                },
                expirationDateTo: {
                    type: "string",
                    description: "Latest expiration date in YYYY-MM-DD format",
                },
                strikePriceGte: {
                    type: "number",
                    description: "Minimum strike price filter",
                },
                strikePriceLte: {
                    type: "number",
                    description: "Maximum strike price filter",
                },
                optionType: {
                    type: "string",
                    enum: ["call", "put"],
                },
                limit: {
                    type: "number",
                    description: "Maximum number of contracts to return",
                },
            },
            required: ["underlyingSymbol"],
        },
        handler: async (params) => {
            const validated = params as z.infer<typeof paramsSchema>
            const chain = await venue.getOptionsChain(validated.underlyingSymbol, validated)

            const contracts = chain.contracts.map((contract) => {
                const snapshot = chain.snapshots[contract.symbol]
                const bid = snapshot?.latestQuote?.bidPrice
                const ask = snapshot?.latestQuote?.askPrice
                const midpoint = bid !== undefined && ask !== undefined
                    ? (bid + ask) / 2
                    : undefined

                return {
                    symbol: contract.symbol,
                    underlyingSymbol: contract.underlyingSymbol,
                    expirationDate: contract.expirationDate,
                    optionType: contract.optionType,
                    strikePrice: contract.strikePrice,
                    status: contract.status,
                    tradable: contract.tradable,
                    bid,
                    ask,
                    midpoint,
                    bidSize: snapshot?.latestQuote?.bidSize,
                    askSize: snapshot?.latestQuote?.askSize,
                    latestTradePrice: snapshot?.latestTrade?.price,
                    latestTradeSize: snapshot?.latestTrade?.size,
                    openInterest: snapshot?.openInterest ?? contract.openInterest,
                    impliedVolatility: snapshot?.impliedVolatility,
                    greeks: snapshot?.greeks,
                }
            })

            return {
                underlyingSymbol: validated.underlyingSymbol.toUpperCase(),
                contracts,
                nextPageToken: chain.nextPageToken,
            }
        },
    }
}

import { z } from "zod"
import type { AlpacaOptionsVenueAdapter } from "@valiq-trading/alpaca-options"
import type { ToolDefinition } from "../tool-registry"
import {
    createToolDefinition,
    getOptionsChainParamsSchema,
} from "../tool-contracts"

export function createAlpacaGetOptionsChainTool(
    venue: AlpacaOptionsVenueAdapter
): ToolDefinition {
    return createToolDefinition({
        name: "get_options_chain",
        venue: "alpaca-options",
        handler: async (params) => {
            const validated = params as z.infer<typeof getOptionsChainParamsSchema>
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
    })
}

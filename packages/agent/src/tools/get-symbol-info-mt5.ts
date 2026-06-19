import { z } from "zod"
import {
    resolveMT5AllowedSymbol,
    resolveMT5NormalizedSpread,
    type MT5VenueAdapter,
} from "@valiq-trading/mt5"
import type { ToolBinding } from "../tool-registry"
import {
    createToolBinding,
    singleSymbolParamsSchema,
} from "../tool-contracts"
import { withMT5SymbolAllowList } from "./mt5-symbol-allow-list"

export function createMT5GetSymbolInfoTool(
    venue: MT5VenueAdapter,
    allowedSymbols: readonly string[] = []
): ToolBinding {
    return withMT5SymbolAllowList(createToolBinding({
        name: "get_symbol_info",
        venue: "mt5",
        handler: async (params) => {
            const validated = params as z.infer<typeof singleSymbolParamsSchema>
            const symbol = resolveMT5AllowedSymbol(validated.symbol, allowedSymbols)
            const info = await venue.getSymbolInfo(symbol)

            if (!info) {
                return {
                    symbol,
                    found: false,
                    message: `No MT5 symbol info found for ${symbol}`,
                }
            }

            const spread = resolveMT5NormalizedSpread(info)
            const executionCost = await venue.assessSymbolExecutionCost(info)

            return {
                symbol: info.symbol,
                found: true,
                bid: info.bid,
                ask: info.ask,
                spread: spread.value,
                spreadUnit: spread.unit,
                rawSpreadPoints: info.spread,
                tickValue: info.tickValue,
                contractSize: info.contractSize,
                volumeMin: info.volumeMin,
                volumeMax: info.volumeMax,
                volumeStep: info.volumeStep,
                digits: info.digits,
                point: info.point,
                pipSize: info.pipSize,
                currency: info.currency,
                description: info.description,
                executionCost,
            }
        },
    }), "symbol", allowedSymbols)
}

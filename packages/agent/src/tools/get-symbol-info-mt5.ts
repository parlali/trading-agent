import { z } from "zod"
import type { MT5VenueAdapter } from "@valiq-trading/mt5"
import type { ToolDefinition } from "../tool-registry"

const paramsSchema = z.object({
    symbol: z.string(),
})

export function createMT5GetSymbolInfoTool(
    venue: MT5VenueAdapter
): ToolDefinition {
    return {
        name: "get_symbol_info",
        description: "Fetch live MT5 symbol information including bid, ask, spread, tick value, contract size, and volume constraints.",
        parameters: paramsSchema,
        jsonSchema: {
            type: "object",
            properties: {
                symbol: {
                    type: "string",
                    description: "MT5 symbol such as XAUUSD or US30",
                },
            },
            required: ["symbol"],
        },
        handler: async (params) => {
            const validated = params as z.infer<typeof paramsSchema>
            const info = await venue.getSymbolInfo(validated.symbol)

            if (!info) {
                return {
                    symbol: validated.symbol.toUpperCase(),
                    found: false,
                    message: `No MT5 symbol info found for ${validated.symbol}`,
                }
            }

            return {
                symbol: info.symbol,
                found: true,
                bid: info.bid,
                ask: info.ask,
                spreadInPips: info.spread,
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
            }
        },
    }
}

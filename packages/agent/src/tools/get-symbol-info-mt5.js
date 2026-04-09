import { createToolDefinition, } from "../tool-contracts";
export function createMT5GetSymbolInfoTool(venue) {
    return createToolDefinition({
        name: "get_symbol_info",
        venue: "mt5",
        handler: async (params) => {
            const validated = params;
            const info = await venue.getSymbolInfo(validated.symbol);
            if (!info) {
                return {
                    symbol: validated.symbol.toUpperCase(),
                    found: false,
                    message: `No MT5 symbol info found for ${validated.symbol}`,
                };
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
            };
        },
    });
}

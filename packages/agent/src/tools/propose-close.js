import { createToolDefinition, } from "../tool-contracts";
import { toExecutionToolResult } from "./execution-response";
import { resolveEstimatedPrice as resolvePolymarketEstimatedPrice, } from "./polymarket-order-helpers";
export function createProposeCloseTool(pipeline, options = {}) {
    return createToolDefinition({
        name: "propose_close",
        venue: "alpaca-options",
        handler: async (params) => {
            const validated = params;
            const positions = await pipeline.getPositions();
            const position = positions.find((item) => item.instrument === validated.instrument);
            const closeSide = position?.side === "short" ? "buy" : "sell";
            const estimatedPrice = position
                ? await options.resolveEstimatedPrice?.({
                    instrument: validated.instrument,
                    reason: validated.reason,
                    closeSide,
                    position,
                })
                : undefined;
            const { result, validation } = await pipeline.closePosition(validated.instrument, validated.reason, { estimatedPrice });
            return toExecutionToolResult(result, { validation });
        },
    });
}
export function createPolymarketProposeCloseTool(pipeline, venue) {
    return createToolDefinition({
        name: "propose_close",
        venue: "polymarket",
        handler: createProposeCloseTool(pipeline, {
            resolveEstimatedPrice: async ({ instrument, closeSide }) => await resolvePolymarketEstimatedPrice(venue, instrument, closeSide),
        }).handler,
    });
}
export function createMT5ProposeCloseTool(pipeline, venue) {
    return createToolDefinition({
        name: "propose_close",
        venue: "mt5",
        handler: createProposeCloseTool(pipeline, {
            resolveEstimatedPrice: async ({ instrument, closeSide }) => {
                const symbolInfo = await venue.getSymbolInfo(instrument);
                if (!symbolInfo) {
                    return undefined;
                }
                return closeSide === "buy" ? symbolInfo.ask : symbolInfo.bid;
            },
        }).handler,
    });
}
export function createBinanceProposeCloseTool(pipeline, venue) {
    return createToolDefinition({
        name: "propose_close",
        venue: "binance-futures",
        handler: createProposeCloseTool(pipeline, {
            resolveEstimatedPrice: async ({ instrument }) => {
                return await venue.getCurrentMarkPrice(instrument);
            },
        }).handler,
    });
}

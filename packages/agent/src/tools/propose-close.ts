import { z } from "zod"
import type { ExecutionPipeline, Position } from "@valiq-trading/core"
import type { MT5VenueAdapter } from "@valiq-trading/mt5"
import type { BinanceVenueAdapter } from "@valiq-trading/binance"
import type { ToolDefinition } from "../tool-registry"
import {
    closeParamsSchema,
    createToolDefinition,
} from "../tool-contracts"
import { toExecutionToolResult } from "./execution-response"
import {
    resolveEstimatedPrice as resolvePolymarketEstimatedPrice,
    type PolymarketPriceProvider,
} from "./polymarket-order-helpers"

interface ClosePriceResolverContext {
    instrument: string
    reason: string
    closeSide: "buy" | "sell"
    position: Position | undefined
}

interface CreateProposeCloseToolOptions {
    resolveEstimatedPrice?: (context: ClosePriceResolverContext) => Promise<number | undefined>
}

export function createProposeCloseTool(
    pipeline: ExecutionPipeline,
    options: CreateProposeCloseToolOptions = {}
): ToolDefinition {
    return createToolDefinition({
        name: "propose_close",
        venue: "alpaca-options",
        handler: async (params) => {
            const validated = params as z.infer<typeof closeParamsSchema>
            const positions = await pipeline.getPositions()
            const position = positions.find((item) => item.instrument === validated.instrument)
            const closeSide = position?.side === "short" ? "buy" : "sell"
            const estimatedPrice = position
                ? await options.resolveEstimatedPrice?.({
                    instrument: validated.instrument,
                    reason: validated.reason,
                    closeSide,
                    position,
                })
                : undefined
            const { result, validation } = await pipeline.closePosition(
                validated.instrument,
                validated.reason,
                { estimatedPrice }
            )

            return toExecutionToolResult(result, { validation })
        },
    })
}

export function createPolymarketProposeCloseTool(
    pipeline: ExecutionPipeline,
    venue: PolymarketPriceProvider
): ToolDefinition {
    return createToolDefinition({
        name: "propose_close",
        venue: "polymarket",
        handler: createProposeCloseTool(pipeline, {
            resolveEstimatedPrice: async ({ instrument, closeSide }) =>
                await resolvePolymarketEstimatedPrice(venue, instrument, closeSide),
        }).handler,
    })
}

export function createMT5ProposeCloseTool(
    pipeline: ExecutionPipeline,
    venue: MT5VenueAdapter
): ToolDefinition {
    return createToolDefinition({
        name: "propose_close",
        venue: "mt5",
        handler: createProposeCloseTool(pipeline, {
            resolveEstimatedPrice: async ({ instrument, closeSide }) => {
                const symbolInfo = await venue.getSymbolInfo(instrument)
                if (!symbolInfo) {
                    return undefined
                }

                return closeSide === "buy" ? symbolInfo.ask : symbolInfo.bid
            },
        }).handler,
    })
}

export function createBinanceProposeCloseTool(
    pipeline: ExecutionPipeline,
    venue: BinanceVenueAdapter
): ToolDefinition {
    return createToolDefinition({
        name: "propose_close",
        venue: "binance-futures",
        handler: createProposeCloseTool(pipeline, {
            resolveEstimatedPrice: async ({ instrument }) => {
                return await venue.getCurrentMarkPrice(instrument)
            },
        }).handler,
    })
}

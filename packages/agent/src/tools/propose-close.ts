import { z } from "zod"
import type { ExecutionPipeline, Position } from "@valiq-trading/core"
import type { AlpacaOptionsVenueAdapter } from "@valiq-trading/alpaca-options"
import type { MT5VenueAdapter } from "@valiq-trading/mt5"
import type { OKXVenueAdapter } from "@valiq-trading/okx"
import type { ToolBinding } from "../tool-registry"
import {
    closeParamsSchema,
    createToolBinding,
} from "../tool-contracts"
import { assertToolNotAborted } from "../tool-registry"
import { toExecutionToolResult } from "./execution-response"
import {
    resolveEstimatedPrice as resolvePolymarketEstimatedPrice,
    type PolymarketPriceProvider,
} from "./polymarket-order-helpers"
import { normalizePolymarketTokenId } from "./polymarket-market-handles"

interface ClosePriceResolverContext {
    instrument: string
    reason: string
    closeSide: "buy" | "sell"
    position: Position | undefined
    signal?: AbortSignal
}

interface CreateProposeCloseToolOptions {
    resolveEstimatedPrice?: (context: ClosePriceResolverContext) => Promise<number | undefined>
}

export function createProposeCloseTool(
    pipeline: ExecutionPipeline,
    options: CreateProposeCloseToolOptions = {}
): ToolBinding {
    return createToolBinding({
        name: "propose_close",
        venue: "alpaca-options",
        handler: async (params, context) => {
            const validated = params as z.infer<typeof closeParamsSchema>
            assertToolNotAborted(context?.signal)
            const positions = await pipeline.getPositions()
            const position = positions.find((item) => item.instrument === validated.instrument)
            const closeSide = position?.side === "short" ? "buy" : "sell"
            assertToolNotAborted(context?.signal)
            const estimatedPrice = await options.resolveEstimatedPrice?.({
                instrument: validated.instrument,
                reason: validated.reason,
                closeSide,
                position,
                signal: context?.signal,
            })
            assertToolNotAborted(context?.signal)
            const { result, validation } = await pipeline.closePosition(
                validated.instrument,
                validated.reason,
                { estimatedPrice }
            )

            assertToolNotAborted(context?.signal)
            return toExecutionToolResult(result, { validation })
        },
    })
}

export function createAlpacaProposeCloseTool(
    pipeline: ExecutionPipeline,
    venue: AlpacaOptionsVenueAdapter
): ToolBinding {
    return createToolBinding({
        name: "propose_close",
        venue: "alpaca-options",
        handler: createProposeCloseTool(pipeline, {
            resolveEstimatedPrice: async ({ instrument, signal }) => {
                assertToolNotAborted(signal)
                const closeIntent = await venue.buildCloseIntent(instrument)
                const estimatedPrice = closeIntent.metadata?.estimatedPrice
                return typeof estimatedPrice === "number" && Number.isFinite(estimatedPrice) && estimatedPrice > 0
                    ? estimatedPrice
                    : closeIntent.limitPrice
            },
        }).handler,
    })
}

export function createPolymarketProposeCloseTool(
    pipeline: ExecutionPipeline,
    venue: PolymarketPriceProvider
): ToolBinding {
    const base = createProposeCloseTool(pipeline, {
        resolveEstimatedPrice: async ({ instrument, closeSide }) =>
            await resolvePolymarketEstimatedPrice(venue, instrument, closeSide),
    })

    return createToolBinding({
        name: "propose_close",
        venue: "polymarket",
        handler: async (params, context) => {
            const validated = params as z.infer<typeof closeParamsSchema>
            return await base.handler({
                ...validated,
                instrument: normalizePolymarketTokenId(validated.instrument),
            }, context)
        },
    })
}

export function createMT5ProposeCloseTool(
    pipeline: ExecutionPipeline,
    venue: MT5VenueAdapter
): ToolBinding {
    return createToolBinding({
        name: "propose_close",
        venue: "mt5",
        handler: createProposeCloseTool(pipeline, {
            resolveEstimatedPrice: async ({ instrument, closeSide, signal }) => {
                assertToolNotAborted(signal)
                const symbolInfo = await venue.getSymbolInfo(instrument)
                if (!symbolInfo) {
                    return undefined
                }

                return closeSide === "buy" ? symbolInfo.ask : symbolInfo.bid
            },
        }).handler,
    })
}

export function createOKXProposeCloseTool(
    pipeline: ExecutionPipeline,
    venue: OKXVenueAdapter
): ToolBinding {
    return createToolBinding({
        name: "propose_close",
        venue: "okx-swap",
        handler: createProposeCloseTool(pipeline, {
            resolveEstimatedPrice: async ({ instrument, signal }) => {
                assertToolNotAborted(signal)
                return await venue.getCurrentMarkPrice(instrument)
            },
        }).handler,
    })
}

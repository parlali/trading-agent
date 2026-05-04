import { z } from "zod"
import type { ExecutionPipeline, OrderIntent } from "@valiq-trading/core"
import type { ToolDefinition } from "../tool-registry"
import {
    createToolDefinition,
    genericAdjustmentParamsSchema,
} from "../tool-contracts"
import { executeToolIntent } from "./execution-response"
import { resolveEstimatedPrice, type PolymarketPriceProvider } from "./polymarket-order-helpers"
import { normalizePolymarketTokenId } from "./polymarket-market-handles"

export function createPolymarketProposeAdjustmentTool(
    pipeline: ExecutionPipeline,
    venue: PolymarketPriceProvider
): ToolDefinition {
    return createToolDefinition({
        name: "propose_adjustment",
        venue: "polymarket",
        handler: async (params) => {
            const validated = params as z.infer<typeof genericAdjustmentParamsSchema>
            const instrument = normalizePolymarketTokenId(validated.instrument)
            const positions = await pipeline.getPositions()
            const existingPosition = positions.find((position) => position.instrument === instrument)

            const estimatedPrice = await resolveEstimatedPrice(
                venue,
                instrument,
                validated.side,
                validated.limitPrice
            )

            const intent: OrderIntent = {
                instrument,
                side: validated.side,
                quantity: validated.quantity,
                orderType: validated.orderType,
                limitPrice: validated.limitPrice,
                stopPrice: validated.stopPrice,
                timeInForce: validated.timeInForce,
                metadata: {
                    ...existingPosition?.metadata,
                    action: "adjustment",
                    reason: validated.reason,
                    estimatedPrice,
                    currentPrice: estimatedPrice,
                },
            }

            return await executeToolIntent(pipeline, intent, { action: "adjustment" }, { positions })
        },
    })
}

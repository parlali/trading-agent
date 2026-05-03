import { z } from "zod"
import type { ExecutionPipeline, OrderIntent } from "@valiq-trading/core"
import type { ToolDefinition } from "../tool-registry"
import {
    createToolDefinition,
    genericAdjustmentParamsSchema,
} from "../tool-contracts"
import { toExecutionToolResult } from "./execution-response"
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
            const [positions, account] = await Promise.all([
                pipeline.getPositions(),
                pipeline.getAccountState(),
            ])
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

            const { result, validation } = await pipeline.executeIntent(
                intent,
                account,
                positions,
                { action: "adjustment" }
            )

            return toExecutionToolResult(result, { validation })
        },
    })
}

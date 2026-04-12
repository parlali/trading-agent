import { z } from "zod"
import type { ExecutionPipeline, OrderIntent } from "@valiq-trading/core"
import type { ToolDefinition } from "../tool-registry"
import {
    createToolDefinition,
    polymarketOrderParamsSchema,
} from "../tool-contracts"
import { toExecutionToolResult } from "./execution-response"
import { resolveEstimatedPrice, type PolymarketPriceProvider } from "./polymarket-order-helpers"

export function createPolymarketProposeOrderTool(
    pipeline: ExecutionPipeline,
    venue: PolymarketPriceProvider
): ToolDefinition {
    return createToolDefinition({
        name: "propose_order",
        venue: "polymarket",
        handler: async (params) => {
            const validated = params as z.infer<typeof polymarketOrderParamsSchema>
            const [positions, account] = await Promise.all([
                pipeline.getPositions(),
                pipeline.getAccountState(),
            ])

            const estimatedPrice = await resolveEstimatedPrice(
                venue,
                validated.tokenId,
                validated.side,
                validated.limitPrice
            )

            const intent: OrderIntent = {
                instrument: validated.tokenId,
                side: validated.side,
                quantity: validated.quantity,
                orderType: validated.orderType,
                limitPrice: validated.limitPrice,
                timeInForce: validated.timeInForce,
                metadata: {
                    conditionId: validated.conditionId,
                    tokenId: validated.tokenId,
                    marketSlug: validated.marketSlug,
                    question: validated.question,
                    outcome: validated.outcome,
                    category: validated.category,
                    endDateIso: validated.endDateIso,
                    liquidity: validated.liquidity,
                    volume: validated.volume,
                    negRisk: validated.negRisk,
                    estimatedPrice,
                    currentPrice: estimatedPrice,
                },
            }

            const { result, validation, handle } = await pipeline.executeIntent(intent, account, positions, {
                action: "entry",
            })

            return toExecutionToolResult(result, {
                trackedOrder: handle?.snapshot,
                validation,
            })
        },
    })
}

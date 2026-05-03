import { z } from "zod"
import type { ExecutionPipeline, OrderIntent } from "@valiq-trading/core"
import type { ToolDefinition } from "../tool-registry"
import {
    createToolDefinition,
    polymarketOrderParamsSchema,
} from "../tool-contracts"
import { toExecutionToolResult } from "./execution-response"
import { resolveEstimatedPrice, type PolymarketPriceProvider } from "./polymarket-order-helpers"
import { PolymarketMarketHandleRegistry } from "./polymarket-market-handles"

export function createPolymarketProposeOrderTool(
    pipeline: ExecutionPipeline,
    venue: PolymarketPriceProvider,
    handles: PolymarketMarketHandleRegistry = new PolymarketMarketHandleRegistry()
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
            const token = handles.resolveToken(validated)
            const identity = {
                tokenId: token.tokenId,
                conditionId: validated.conditionId ?? token.conditionId,
                marketSlug: validated.marketSlug ?? token.marketSlug,
                question: validated.question ?? token.question,
                outcome: validated.outcome ?? token.outcome,
                category: validated.category ?? token.category,
                endDateIso: validated.endDateIso ?? token.endDateIso,
                liquidity: validated.liquidity ?? token.liquidity,
                volume: validated.volume ?? token.volume,
                negRisk: validated.negRisk ?? token.negRisk,
            }

            if (!identity.conditionId || !identity.marketSlug || !identity.question || !identity.outcome) {
                throw new Error("Polymarket propose_order requires canonical market identity from search_markets when tokenHandle is not provided")
            }

            const estimatedPrice = await resolveEstimatedPrice(
                venue,
                identity.tokenId,
                validated.side,
                validated.limitPrice
            )

            const intent: OrderIntent = {
                instrument: identity.tokenId,
                side: validated.side,
                quantity: validated.quantity,
                orderType: validated.orderType,
                limitPrice: validated.limitPrice,
                timeInForce: validated.timeInForce,
                metadata: {
                    conditionId: identity.conditionId,
                    tokenId: identity.tokenId,
                    tokenHandle: token.tokenHandle || validated.tokenHandle,
                    marketHandle: token.marketHandle || undefined,
                    marketSlug: identity.marketSlug,
                    question: identity.question,
                    outcome: identity.outcome,
                    category: identity.category,
                    endDateIso: identity.endDateIso,
                    liquidity: identity.liquidity,
                    volume: identity.volume,
                    negRisk: identity.negRisk,
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

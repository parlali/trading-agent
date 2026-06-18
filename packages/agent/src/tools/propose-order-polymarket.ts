import { z } from "zod"
import {
    duplicateOrderValidator,
    type AccountState,
    type ExecutionPipeline,
    type OrderIntent,
} from "@valiq-trading/core"
import type { ToolBinding } from "../tool-registry"
import {
    createToolBinding,
    polymarketOrderParamsSchema,
} from "../tool-contracts"
import {
    createRejectedExecutionToolResult,
    executeToolIntent,
} from "./execution-response"
import { resolveEstimatedPrice, type PolymarketPriceProvider } from "./polymarket-order-helpers"
import { PolymarketMarketHandleRegistry } from "./polymarket-market-handles"
import { assertToolNotAborted } from "../tool-registry"

export function createPolymarketProposeOrderTool(
    pipeline: ExecutionPipeline,
    venue: PolymarketPriceProvider,
    handles: PolymarketMarketHandleRegistry = new PolymarketMarketHandleRegistry()
): ToolBinding {
    return createToolBinding({
        name: "propose_order",
        venue: "polymarket",
        handler: async (params, context) => {
            const validated = params as z.infer<typeof polymarketOrderParamsSchema>
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

            const intent = createPolymarketOrderIntent({
                validated,
                token,
                identity,
            })

            assertToolNotAborted(context?.signal)
            const positions = await pipeline.getPositions()
            const duplicateValidation = duplicateOrderValidator(
                intent,
                {},
                {} as AccountState,
                positions
            )
            if (!duplicateValidation.allowed) {
                const reason = duplicateValidation.reason ?? "Duplicate Polymarket exposure is already open"
                return createRejectedExecutionToolResult(reason, {
                    code: reason.startsWith("Duplicate: market ")
                        ? "POLYMARKET_DUPLICATE_MARKET"
                        : "POLYMARKET_DUPLICATE_TOKEN",
                })
            }

            const estimatedPrice = await resolveEstimatedPrice(
                venue,
                identity.tokenId,
                validated.side,
                validated.limitPrice
            )
            assertToolNotAborted(context?.signal)

            return await executeToolIntent(pipeline, {
                ...intent,
                metadata: {
                    ...intent.metadata,
                    estimatedPrice,
                    currentPrice: estimatedPrice,
                },
            }, { action: "entry" }, {
                includeTrackedOrder: true,
                positions,
                signal: context?.signal,
            })
        },
    })
}

function createPolymarketOrderIntent(args: {
    validated: z.infer<typeof polymarketOrderParamsSchema>
    token: ReturnType<PolymarketMarketHandleRegistry["resolveToken"]>
    identity: {
        tokenId: string
        conditionId?: string
        marketSlug?: string
        question?: string
        outcome?: string
        category?: string
        endDateIso?: string
        liquidity?: number
        volume?: number
        negRisk?: boolean
    }
}): OrderIntent {
    return {
        instrument: args.identity.tokenId,
        side: args.validated.side,
        quantity: args.validated.quantity,
        orderType: args.validated.orderType,
        limitPrice: args.validated.limitPrice,
        timeInForce: args.validated.timeInForce,
        metadata: {
            conditionId: args.identity.conditionId,
            tokenId: args.identity.tokenId,
            tokenHandle: args.token.tokenHandle || args.validated.tokenHandle,
            marketHandle: args.token.marketHandle || undefined,
            marketSlug: args.identity.marketSlug,
            question: args.identity.question,
            outcome: args.identity.outcome,
            category: args.identity.category,
            endDateIso: args.identity.endDateIso,
            liquidity: args.identity.liquidity,
            volume: args.identity.volume,
            negRisk: args.identity.negRisk,
        },
    }
}

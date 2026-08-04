import { z } from "zod"
import {
    type ExecutionPipeline,
    type OrderIntent,
} from "@valiq-trading/core"
import type { ToolBinding } from "../tool-registry"
import {
    alpacaOrderParamsSchema,
    createToolBinding,
} from "../tool-contracts"
import { executeToolIntent } from "./execution-response"
import { sanitizeModelIntentMetadata } from "./model-intent-metadata"

export function createProposeOrderTool(
    pipeline: ExecutionPipeline
): ToolBinding {
    return createToolBinding({
        name: "propose_order",
        venue: "alpaca-options",
        handler: async (params, context) => {
            const validated = params as z.infer<typeof alpacaOrderParamsSchema>
            const intent: OrderIntent = {
                instrument: validated.instrument,
                side: validated.side,
                quantity: validated.quantity,
                orderType: validated.orderType,
                limitPrice: validated.limitPrice,
                timeInForce: validated.timeInForce,
                legs: validated.legs,
                metadata: buildAlpacaEntryMetadata(validated),
            }

            return await executeToolIntent(pipeline, intent, { action: "entry" }, {
                includeTrackedOrder: true,
                signal: context?.signal,
            })
        },
    })
}

function buildAlpacaEntryMetadata(
    proposal: z.infer<typeof alpacaOrderParamsSchema>
): Record<string, unknown> | undefined {
    const metadata = sanitizeModelIntentMetadata(proposal.metadata)
    const entryThesis = proposal.entryThesis ?? proposal.thesis
    const proposalMetadata: Record<string, unknown> = {}

    if (proposal.maxLossArithmetic !== undefined) {
        proposalMetadata.maxLossArithmetic = proposal.maxLossArithmetic
    }

    if (entryThesis !== undefined) {
        proposalMetadata.thesis = entryThesis
    }

    return Object.keys(proposalMetadata).length > 0 || metadata
        ? {
            ...metadata,
            ...proposalMetadata,
        }
        : undefined
}

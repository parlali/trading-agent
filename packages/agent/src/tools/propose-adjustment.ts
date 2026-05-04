import { z } from "zod"
import type { ExecutionPipeline, OrderIntent } from "@valiq-trading/core"
import type { ToolDefinition } from "../tool-registry"
import {
    createToolDefinition,
    genericAdjustmentParamsSchema,
} from "../tool-contracts"
import { executeToolIntent } from "./execution-response"

export function createProposeAdjustmentTool(pipeline: ExecutionPipeline): ToolDefinition {
    return createToolDefinition({
        name: "propose_adjustment",
        venue: "alpaca-options",
        handler: async (params) => {
            const validated = params as z.infer<typeof genericAdjustmentParamsSchema>
            const intent: OrderIntent = {
                instrument: validated.instrument,
                side: validated.side,
                quantity: validated.quantity,
                orderType: validated.orderType,
                limitPrice: validated.limitPrice,
                stopPrice: validated.stopPrice,
                timeInForce: validated.timeInForce,
                metadata: {
                    action: "adjustment",
                    reason: validated.reason,
                },
            }

            return await executeToolIntent(pipeline, intent, { action: "adjustment" })
        },
    })
}

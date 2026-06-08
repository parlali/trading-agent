import { z } from "zod"
import type { ExecutionPipeline } from "@valiq-trading/core"
import type { ToolBinding } from "../tool-registry"
import {
    createToolBinding,
    orderIdWithReasonParamsSchema,
} from "../tool-contracts"
import { toExecutionToolResult } from "./execution-response"

export function createCancelOrderTool(pipeline: ExecutionPipeline): ToolBinding {
    return createToolBinding({
        name: "cancel_order",
        handler: async (params) => {
            const validated = params as z.infer<typeof orderIdWithReasonParamsSchema>
            const result = await pipeline.cancelOrder(validated.orderId, validated.reason)
            const trackedOrder = await pipeline.getOrderSnapshot(validated.orderId)

            return toExecutionToolResult(result, { trackedOrder })
        },
    })
}

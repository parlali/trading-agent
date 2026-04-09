import { z } from "zod"
import {
    createExecutionErrorDetail,
    formatExecutionError,
    getErrorMessage,
    getExecutionErrorDetail,
    type ExecutionPipeline,
} from "@valiq-trading/core"
import type { ToolDefinition } from "../tool-registry"
import {
    createToolDefinition,
    orderIdParamsSchema,
} from "../tool-contracts"
import { toExecutionToolResult } from "./execution-response"

export function createGetOrderStatusTool(pipeline: ExecutionPipeline): ToolDefinition {
    return createToolDefinition({
        name: "get_order_status",
        handler: async (params) => {
            const validated = params as z.infer<typeof orderIdParamsSchema>
            try {
                const result = await pipeline.getOrderStatus(validated.orderId)
                const trackedOrder = await pipeline.getOrderSnapshot(validated.orderId)

                return toExecutionToolResult(result, { trackedOrder })
            } catch (error) {
                const errorDetail = getExecutionErrorDetail(error) ?? createExecutionErrorDetail("internal", getErrorMessage(error))
                return {
                    orderId: validated.orderId,
                    status: "unknown",
                    error: formatExecutionError(errorDetail),
                    errorDetail,
                }
            }
        },
    })
}

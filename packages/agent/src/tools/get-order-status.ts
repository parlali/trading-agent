import { z } from "zod"
import {
    createExecutionErrorDetail,
    formatExecutionError,
    getErrorMessage,
    getExecutionErrorDetail,
    type ExecutionPipeline,
} from "@valiq-trading/core"
import type { ToolDefinition } from "../tool-registry"
import { toExecutionToolResult } from "./execution-response"

const paramsSchema = z.object({
    orderId: z.string(),
})

export function createGetOrderStatusTool(pipeline: ExecutionPipeline): ToolDefinition {
    return {
        name: "get_order_status",
        description: "Check the current fill status of a tracked order. Returns the latest status, fill progress, and lifecycle snapshot.",
        parameters: paramsSchema,
        jsonSchema: {
            type: "object",
            properties: {
                orderId: { type: "string", description: "The order ID to check" },
            },
            required: ["orderId"],
        },
        handler: async (params) => {
            const validated = params as z.infer<typeof paramsSchema>
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
    }
}

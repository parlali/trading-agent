import { z } from "zod"
import type { ExecutionPipeline } from "@valiq-trading/core"
import type { ToolDefinition } from "../tool-registry"

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
            const result = await pipeline.getOrderStatus(validated.orderId)
            const trackedOrder = await pipeline.getOrderSnapshot(validated.orderId)

            return {
                orderId: result.orderId,
                status: result.status,
                filledQuantity: result.filledQuantity,
                fillPrice: result.fillPrice,
                error: result.error,
                trackedOrder,
            }
        },
    }
}

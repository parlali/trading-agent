import { z } from "zod"
import type { ExecutionPipeline } from "@valiq-trading/core"
import type { ToolDefinition } from "../tool-registry"
import { toExecutionToolResult } from "./execution-response"

const paramsSchema = z.object({
    orderId: z.string(),
    reason: z.string().optional(),
})

export function createCancelOrderTool(pipeline: ExecutionPipeline): ToolDefinition {
    return {
        name: "cancel_order",
        description: "Cancel a pending unfilled order. Provide the order ID.",
        parameters: paramsSchema,
        jsonSchema: {
            type: "object",
            properties: {
                orderId: { type: "string", description: "The order ID to cancel" },
                reason: { type: "string", description: "Why the order is being cancelled" },
            },
            required: ["orderId"],
        },
        handler: async (params) => {
            const validated = params as z.infer<typeof paramsSchema>
            const result = await pipeline.cancelOrder(validated.orderId, validated.reason)
            const trackedOrder = await pipeline.getOrderSnapshot(validated.orderId)

            return toExecutionToolResult(result, { trackedOrder })
        },
    }
}

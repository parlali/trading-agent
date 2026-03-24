import { z } from "zod"
import type { ExecutionPipeline, OrderIntent } from "@valiq-trading/core"
import type { ToolDefinition } from "../tool-registry"

const paramsSchema = z.object({
    orderId: z.string(),
    limitPrice: z.number().optional(),
    stopPrice: z.number().optional(),
    quantity: z.number().positive().optional(),
    reason: z.string().optional(),
})

export function createModifyOrderTool(pipeline: ExecutionPipeline): ToolDefinition {
    return {
        name: "modify_order",
        description: "Modify a pending order. You can change the limit price, stop price, or quantity. At least one modification field must be provided.",
        parameters: paramsSchema,
        jsonSchema: {
            type: "object",
            properties: {
                orderId: { type: "string", description: "The order ID to modify" },
                limitPrice: { type: "number", description: "New limit price" },
                stopPrice: { type: "number", description: "New stop price" },
                quantity: { type: "number", description: "New quantity" },
                reason: { type: "string", description: "Why the order is being modified" },
            },
            required: ["orderId"],
        },
        handler: async (params) => {
            const validated = params as z.infer<typeof paramsSchema>
            const changes: Partial<OrderIntent> = {}

            if (validated.limitPrice !== undefined) changes.limitPrice = validated.limitPrice
            if (validated.stopPrice !== undefined) changes.stopPrice = validated.stopPrice
            if (validated.quantity !== undefined) changes.quantity = validated.quantity

            const result = await pipeline.modifyOrder(validated.orderId, changes, validated.reason)
            const trackedOrder = await pipeline.getOrderSnapshot(validated.orderId)

            return {
                orderId: result.orderId,
                status: result.status,
                error: result.error,
                trackedOrder,
            }
        },
    }
}

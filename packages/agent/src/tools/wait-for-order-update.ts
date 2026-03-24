import { z } from "zod"
import type { ExecutionPipeline } from "@valiq-trading/core"
import type { ToolDefinition } from "../tool-registry"

const paramsSchema = z.object({
    orderId: z.string(),
    timeoutMs: z.number().int().positive().max(300000).optional(),
})

export function createWaitForOrderUpdateTool(pipeline: ExecutionPipeline): ToolDefinition {
    return {
        name: "wait_for_order_update",
        description: "Wait for the next order lifecycle update in the current run. Use this when an order is still pending or partially filled and you need the refreshed snapshot before deciding what to do next.",
        parameters: paramsSchema,
        jsonSchema: {
            type: "object",
            properties: {
                orderId: { type: "string", description: "The tracked order ID to wait on" },
                timeoutMs: { type: "number", description: "Optional maximum wait for this tool call in milliseconds" },
            },
            required: ["orderId"],
        },
        handler: async (params) => {
            const validated = params as z.infer<typeof paramsSchema>
            const snapshot = await pipeline.waitForOrderUpdate(
                validated.orderId,
                () => ({ decision: "wait" }),
                { timeoutMs: validated.timeoutMs }
            )

            return {
                orderId: snapshot.orderId,
                action: snapshot.action,
                status: snapshot.status,
                quantity: snapshot.quantity,
                filledQuantity: snapshot.filledQuantity,
                remainingQuantity: snapshot.remainingQuantity,
                avgFillPrice: snapshot.avgFillPrice,
                updatedAt: snapshot.updatedAt,
                polling: snapshot.polling,
            }
        },
    }
}

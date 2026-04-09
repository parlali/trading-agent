import { z } from "zod"
import type { ExecutionPipeline } from "@valiq-trading/core"
import type { ToolDefinition } from "../tool-registry"
import {
    createToolDefinition,
    waitForOrderUpdateParamsSchema,
} from "../tool-contracts"

export function createWaitForOrderUpdateTool(pipeline: ExecutionPipeline): ToolDefinition {
    return createToolDefinition({
        name: "wait_for_order_update",
        handler: async (params) => {
            const validated = params as z.infer<typeof waitForOrderUpdateParamsSchema>
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
    })
}

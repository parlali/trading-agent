import { z } from "zod"
import type { ExecutionPipeline, OrderIntent } from "@valiq-trading/core"
import type { ToolDefinition } from "../tool-registry"
import {
    createToolDefinition,
    mt5ModifyOrderParamsSchema,
} from "../tool-contracts"
import { toExecutionToolResult } from "./execution-response"

export function createMT5ModifyOrderTool(pipeline: ExecutionPipeline): ToolDefinition {
    return createToolDefinition({
        name: "modify_order",
        venue: "mt5",
        handler: async (params) => {
            const validated = params as z.infer<typeof mt5ModifyOrderParamsSchema>
            const changes: Partial<OrderIntent> = {
                metadata: {
                    stopLoss: validated.newStopLoss,
                    takeProfit: validated.newTakeProfit,
                },
            }

            const orderId = String(validated.orderId)
            const result = await pipeline.modifyOrder(orderId, changes, validated.reason)
            const trackedOrder = await pipeline.getOrderSnapshot(orderId)

            return toExecutionToolResult(result, { trackedOrder })
        },
    })
}

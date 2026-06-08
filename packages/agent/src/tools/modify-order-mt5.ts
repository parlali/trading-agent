import { z } from "zod"
import type { ExecutionPipeline, OrderIntent } from "@valiq-trading/core"
import type { ToolBinding } from "../tool-registry"
import {
    createToolBinding,
    mt5ModifyOrderParamsSchema,
} from "../tool-contracts"
import { toExecutionToolResult } from "./execution-response"
import { assertToolNotAborted } from "../tool-registry"

export function createMT5ModifyOrderTool(pipeline: ExecutionPipeline): ToolBinding {
    return createToolBinding({
        name: "modify_order",
        venue: "mt5",
        handler: async (params, context) => {
            const validated = params as z.infer<typeof mt5ModifyOrderParamsSchema>
            const changes: Partial<OrderIntent> = {
                metadata: {
                    stopLoss: validated.newStopLoss,
                    takeProfit: validated.newTakeProfit,
                },
            }

            const orderId = String(validated.orderId)
            assertToolNotAborted(context?.signal)
            const result = await pipeline.modifyOrder(orderId, changes, validated.reason)
            assertToolNotAborted(context?.signal)
            const trackedOrder = await pipeline.getOrderSnapshot(orderId)

            return toExecutionToolResult(result, { trackedOrder })
        },
    })
}

import { z } from "zod"
import type { ExecutionPipeline, OrderIntent } from "@valiq-trading/core"
import type { ToolBinding } from "../tool-registry"
import {
    alpacaModifyOrderParamsSchema,
    createToolBinding,
} from "../tool-contracts"
import { toExecutionToolResult } from "./execution-response"
import { assertToolNotAborted } from "../tool-registry"

interface CreateModifyOrderToolOptions {
    mode?: "default" | "alpaca-options"
}

export function createModifyOrderTool(
    pipeline: ExecutionPipeline,
    options: CreateModifyOrderToolOptions = {}
): ToolBinding {
    if (options.mode !== "alpaca-options") {
        throw new Error("createModifyOrderTool requires mode alpaca-options")
    }

    const paramsSchema = alpacaModifyOrderParamsSchema

    return createToolBinding({
        name: "modify_order",
        venue: "alpaca-options",
        handler: async (params, context) => {
            const validated = params as z.infer<typeof paramsSchema>
            const changes: Partial<OrderIntent> = {}

            if (validated.limitPrice !== undefined) changes.limitPrice = validated.limitPrice
            if (validated.quantity !== undefined) changes.quantity = validated.quantity

            assertToolNotAborted(context?.signal)
            const result = await pipeline.modifyOrder(validated.orderId, changes, validated.reason)
            assertToolNotAborted(context?.signal)
            const trackedOrder = await pipeline.getOrderSnapshot(validated.orderId)

            return toExecutionToolResult(result, { trackedOrder })
        },
    })
}

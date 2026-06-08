import { z } from "zod"
import type { ExecutionPipeline, OrderIntent } from "@valiq-trading/core"
import type { ToolBinding } from "../tool-registry"
import {
    alpacaModifyOrderParamsSchema,
    createToolBinding,
    defaultModifyOrderParamsSchema,
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
    const isAlpacaOptions = options.mode === "alpaca-options"
    const paramsSchema = isAlpacaOptions
        ? alpacaModifyOrderParamsSchema
        : defaultModifyOrderParamsSchema

    return createToolBinding({
        name: "modify_order",
        venue: isAlpacaOptions ? "alpaca-options" : "polymarket",
        handler: async (params, context) => {
            const validated = params as z.infer<typeof paramsSchema>
            const changes: Partial<OrderIntent> = {}

            if (validated.limitPrice !== undefined) changes.limitPrice = validated.limitPrice
            if ("stopPrice" in validated && validated.stopPrice !== undefined) {
                changes.stopPrice = validated.stopPrice as number
            }
            if (validated.quantity !== undefined) changes.quantity = validated.quantity

            assertToolNotAborted(context?.signal)
            const result = await pipeline.modifyOrder(validated.orderId, changes, validated.reason)
            assertToolNotAborted(context?.signal)
            const trackedOrder = await pipeline.getOrderSnapshot(validated.orderId)

            return toExecutionToolResult(result, { trackedOrder })
        },
    })
}

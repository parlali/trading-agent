import { z } from "zod"
import type { ExecutionPipeline, OrderIntent } from "@valiq-trading/core"
import type { ToolDefinition } from "../tool-registry"
import {
    alpacaModifyOrderParamsSchema,
    createToolDefinition,
    defaultModifyOrderParamsSchema,
} from "../tool-contracts"
import { toExecutionToolResult } from "./execution-response"

interface CreateModifyOrderToolOptions {
    mode?: "default" | "alpaca-options"
}

export function createModifyOrderTool(
    pipeline: ExecutionPipeline,
    options: CreateModifyOrderToolOptions = {}
): ToolDefinition {
    const isAlpacaOptions = options.mode === "alpaca-options"
    const paramsSchema = isAlpacaOptions
        ? alpacaModifyOrderParamsSchema
        : defaultModifyOrderParamsSchema

    return createToolDefinition({
        name: "modify_order",
        venue: isAlpacaOptions ? "alpaca-options" : "polymarket",
        handler: async (params) => {
            const validated = params as z.infer<typeof paramsSchema>
            const changes: Partial<OrderIntent> = {}

            if (validated.limitPrice !== undefined) changes.limitPrice = validated.limitPrice
            if ("stopPrice" in validated && validated.stopPrice !== undefined) {
                changes.stopPrice = validated.stopPrice as number
            }
            if (validated.quantity !== undefined) changes.quantity = validated.quantity

            const result = await pipeline.modifyOrder(validated.orderId, changes, validated.reason)
            const trackedOrder = await pipeline.getOrderSnapshot(validated.orderId)

            return toExecutionToolResult(result, { trackedOrder })
        },
    })
}

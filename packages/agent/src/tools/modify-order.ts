import { z } from "zod"
import type { ExecutionPipeline, OrderIntent } from "@valiq-trading/core"
import type { ToolDefinition } from "../tool-registry"
import { toExecutionToolResult } from "./execution-response"

const defaultParamsSchema = z.object({
    orderId: z.string(),
    limitPrice: z.number().optional(),
    stopPrice: z.number().optional(),
    quantity: z.number().positive().optional(),
    reason: z.string().optional(),
})

const alpacaParamsSchema = z.object({
    orderId: z.string(),
    limitPrice: z.number().positive().optional(),
    quantity: z.number().int().positive().optional(),
    reason: z.string().optional(),
})

interface CreateModifyOrderToolOptions {
    mode?: "default" | "alpaca-options"
}

export function createModifyOrderTool(
    pipeline: ExecutionPipeline,
    options: CreateModifyOrderToolOptions = {}
): ToolDefinition {
    const isAlpacaOptions = options.mode === "alpaca-options"
    const paramsSchema = isAlpacaOptions ? alpacaParamsSchema : defaultParamsSchema

    return {
        name: "modify_order",
        description: isAlpacaOptions
            ? "Modify a working Alpaca iron condor order. Supported changes are the net limit price and, if truly necessary, the structure quantity."
            : "Modify a pending order. You can change the limit price, stop price, or quantity. At least one modification field must be provided.",
        parameters: paramsSchema,
        jsonSchema: isAlpacaOptions
            ? {
                type: "object",
                properties: {
                    orderId: { type: "string", description: "The order ID to modify" },
                    limitPrice: { type: "number", description: "New net limit price for the full structure" },
                    quantity: { type: "number", description: "Optional new structure quantity" },
                    reason: { type: "string", description: "Why the order is being modified" },
                },
                required: ["orderId"],
            }
            : {
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
            if ("stopPrice" in validated && validated.stopPrice !== undefined) {
                changes.stopPrice = validated.stopPrice as number
            }
            if (validated.quantity !== undefined) changes.quantity = validated.quantity

            const result = await pipeline.modifyOrder(validated.orderId, changes, validated.reason)
            const trackedOrder = await pipeline.getOrderSnapshot(validated.orderId)

            return toExecutionToolResult(result, { trackedOrder })
        },
    }
}

import { z } from "zod"
import {
    type ExecutionPipeline,
    type OrderIntent,
} from "@valiq-trading/core"
import type { ToolDefinition } from "../tool-registry"
import {
    alpacaOrderParamsSchema,
    createToolDefinition,
    genericOrderParamsSchema,
} from "../tool-contracts"
import { executeToolIntent } from "./execution-response"

interface CreateProposeOrderToolOptions {
    mode?: "default" | "alpaca-options"
}

export function createProposeOrderTool(
    pipeline: ExecutionPipeline,
    options: CreateProposeOrderToolOptions = {}
): ToolDefinition {
    const isAlpacaOptions = options.mode === "alpaca-options"
    const orderParamsSchema = isAlpacaOptions ? alpacaOrderParamsSchema : genericOrderParamsSchema

    return createToolDefinition({
        name: "propose_order",
        venue: isAlpacaOptions ? "alpaca-options" : "polymarket",
        handler: async (params) => {
            const validated = params as z.infer<typeof orderParamsSchema>
            const intent: OrderIntent = {
                instrument: validated.instrument,
                side: validated.side,
                quantity: validated.quantity,
                orderType: validated.orderType,
                limitPrice: validated.limitPrice,
                stopPrice: "stopPrice" in validated ? validated.stopPrice : undefined,
                timeInForce: validated.timeInForce,
                legs: validated.legs,
                metadata: validated.metadata,
            }

            return await executeToolIntent(pipeline, intent, { action: "entry" }, { includeTrackedOrder: true })
        },
    })
}

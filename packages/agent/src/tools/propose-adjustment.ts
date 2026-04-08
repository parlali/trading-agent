import { z } from "zod"
import type { ExecutionPipeline, OrderIntent } from "@valiq-trading/core"
import type { ToolDefinition } from "../tool-registry"
import { toExecutionToolResult } from "./execution-response"

const adjustmentParamsSchema = z.object({
    instrument: z.string(),
    side: z.enum(["buy", "sell"]),
    quantity: z.number().positive(),
    orderType: z.enum(["market", "limit", "stop", "stop_limit"]),
    limitPrice: z.number().optional(),
    stopPrice: z.number().optional(),
    timeInForce: z.enum(["day", "gtc", "ioc", "fok"]).default("day"),
    reason: z.string(),
})

export function createProposeAdjustmentTool(pipeline: ExecutionPipeline): ToolDefinition {
    return {
        name: "propose_adjustment",
        description: "Propose adjusting an existing position by adding to or partially reducing it. Provide the instrument, direction, and quantity of the adjustment. Include a reason for the adjustment.",
        parameters: adjustmentParamsSchema,
        jsonSchema: {
            type: "object",
            properties: {
                instrument: { type: "string", description: "The instrument to adjust" },
                side: { type: "string", enum: ["buy", "sell"], description: "Direction of the adjustment" },
                quantity: { type: "number", description: "Quantity to adjust by" },
                orderType: { type: "string", enum: ["market", "limit", "stop", "stop_limit"] },
                limitPrice: { type: "number" },
                stopPrice: { type: "number" },
                timeInForce: { type: "string", enum: ["day", "gtc", "ioc", "fok"], default: "day" },
                reason: { type: "string", description: "Why this adjustment is being made" },
            },
            required: ["instrument", "side", "quantity", "orderType", "reason"],
        },
        handler: async (params) => {
            const validated = params as z.infer<typeof adjustmentParamsSchema>
            const [positions, account] = await Promise.all([
                pipeline.getPositions(),
                pipeline.getAccountState(),
            ])

            const intent: OrderIntent = {
                instrument: validated.instrument,
                side: validated.side,
                quantity: validated.quantity,
                orderType: validated.orderType,
                limitPrice: validated.limitPrice,
                stopPrice: validated.stopPrice,
                timeInForce: validated.timeInForce,
                metadata: {
                    action: "adjustment",
                    reason: validated.reason,
                },
            }

            const { result, validation } = await pipeline.executeIntent(
                intent,
                account,
                positions,
                { action: "adjustment" }
            )

            return toExecutionToolResult(result, { validation })
        },
    }
}

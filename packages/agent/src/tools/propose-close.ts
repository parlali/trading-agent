import { z } from "zod"
import type { ExecutionPipeline } from "@valiq-trading/core"
import type { ToolDefinition } from "../tool-registry"

const closeParamsSchema = z.object({
    instrument: z.string(),
    reason: z.string(),
})

export function createProposeCloseTool(pipeline: ExecutionPipeline): ToolDefinition {
    return {
        name: "propose_close",
        description: "Propose closing an entire position for a given instrument. Provide the instrument and a reason for closing.",
        parameters: closeParamsSchema,
        jsonSchema: {
            type: "object",
            properties: {
                instrument: { type: "string", description: "The instrument to close the position for" },
                reason: { type: "string", description: "Why the position is being closed" },
            },
            required: ["instrument", "reason"],
        },
        handler: async (params) => {
            const validated = params as z.infer<typeof closeParamsSchema>
            const { result, validation } = await pipeline.closePosition(validated.instrument, validated.reason)

            return {
                orderId: result.orderId,
                status: result.status,
                filledQuantity: result.filledQuantity,
                fillPrice: result.fillPrice,
                error: result.error,
                riskValidation: {
                    allowed: validation.allowed,
                    reason: validation.reason,
                },
            }
        },
    }
}

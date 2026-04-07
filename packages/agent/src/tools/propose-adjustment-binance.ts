import { z } from "zod"
import type { BinanceVenueAdapter } from "@valiq-trading/binance"
import type { ExecutionPipeline } from "@valiq-trading/core"
import type { ToolDefinition } from "../tool-registry"

const binanceAdjustmentParamsSchema = z.object({
    instrument: z.string(),
    stopLoss: z.number().optional(),
    takeProfit: z.number().optional(),
    reason: z.string(),
})

export function createBinanceProposeAdjustmentTool(
    pipeline: ExecutionPipeline,
    venue: BinanceVenueAdapter,
    options?: {
        dryRun?: boolean
    }
): ToolDefinition {
    return {
        name: "propose_adjustment",
        description: "Update protective stop-loss/take-profit orders for an existing Binance futures position.",
        parameters: binanceAdjustmentParamsSchema,
        jsonSchema: {
            type: "object",
            properties: {
                instrument: { type: "string", description: "Perpetual symbol, e.g. BTCUSDT or ETHUSDT" },
                stopLoss: { type: "number", description: "New stop-loss price" },
                takeProfit: { type: "number", description: "New take-profit price" },
                reason: { type: "string", description: "Why this adjustment is needed" },
            },
            required: ["instrument", "reason"],
        },
        handler: async (params) => {
            const validated = params as z.infer<typeof binanceAdjustmentParamsSchema>

            if (validated.stopLoss === undefined && validated.takeProfit === undefined) {
                return {
                    status: "rejected",
                    error: "Provide stopLoss, takeProfit, or both",
                }
            }

            const positions = await pipeline.getPositions()
            const position = positions.find((entry) => entry.instrument.toUpperCase() === validated.instrument.toUpperCase())
            if (!position) {
                return {
                    status: "rejected",
                    error: `No open position found for ${validated.instrument.toUpperCase()}`,
                }
            }

            if (options?.dryRun) {
                return {
                    status: "updated",
                    instrument: validated.instrument.toUpperCase(),
                    side: position.side,
                    quantity: position.quantity,
                    cancelledOrderIds: [],
                    createdOrderIds: [],
                    reason: validated.reason,
                    dryRun: true,
                    note: "Dry run mode: protection orders were not sent to Binance",
                }
            }

            const protectionUpdate = await venue.updateProtectionOrders({
                instrument: validated.instrument,
                stopLoss: validated.stopLoss,
                takeProfit: validated.takeProfit,
            })

            return {
                status: "updated",
                instrument: validated.instrument.toUpperCase(),
                side: position.side,
                quantity: position.quantity,
                cancelledOrderIds: protectionUpdate.cancelledOrderIds,
                createdOrderIds: protectionUpdate.createdOrderIds,
                reason: validated.reason,
            }
        },
    }
}

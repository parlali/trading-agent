import { z } from "zod"
import type { BinanceVenueAdapter } from "@valiq-trading/binance"
import { createExecutionErrorDetail, formatExecutionError, type ExecutionPipeline } from "@valiq-trading/core"
import type { ToolDefinition } from "../tool-registry"
import {
    binanceAdjustmentParamsSchema,
    createToolDefinition,
} from "../tool-contracts"

export function createBinanceProposeAdjustmentTool(
    pipeline: ExecutionPipeline,
    venue: BinanceVenueAdapter,
    options?: {
        dryRun?: boolean
    }
): ToolDefinition {
    return createToolDefinition({
        name: "propose_adjustment",
        venue: "binance-futures",
        handler: async (params) => {
            const validated = params as z.infer<typeof binanceAdjustmentParamsSchema>

            if (validated.stopLoss === undefined && validated.takeProfit === undefined) {
                const errorDetail = createExecutionErrorDetail("pre_validation", "Provide stopLoss, takeProfit, or both", {
                    retryable: false,
                })
                return {
                    status: "rejected",
                    error: formatExecutionError(errorDetail),
                    errorDetail,
                }
            }

            const positions = await pipeline.getPositions()
            const position = positions.find((entry) => entry.instrument.toUpperCase() === validated.instrument.toUpperCase())
            if (!position) {
                const errorDetail = createExecutionErrorDetail(
                    "pre_validation",
                    `No open position found for ${validated.instrument.toUpperCase()}`,
                    {
                        code: "POSITION_NOT_FOUND",
                        retryable: false,
                    }
                )
                return {
                    status: "rejected",
                    error: formatExecutionError(errorDetail),
                    errorDetail,
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
    })
}

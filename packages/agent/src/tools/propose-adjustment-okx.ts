import { z } from "zod"
import type { OKXVenueAdapter } from "@valiq-trading/okx"
import { createExecutionErrorDetail, formatExecutionError, type ExecutionPipeline } from "@valiq-trading/core"
import type { ToolDefinition } from "../tool-registry"
import {
    createToolDefinition,
    okxAdjustmentParamsSchema,
} from "../tool-contracts"
import { createRejectedExecutionToolResult } from "./execution-response"
import type { ExecutionSafetyToolCallbacks } from "./execution-safety"

export function createOKXProposeAdjustmentTool(
    pipeline: ExecutionPipeline,
    venue: OKXVenueAdapter,
    options?: ExecutionSafetyToolCallbacks & {
        dryRun?: boolean
        requireTakeProfit?: boolean
    }
): ToolDefinition {
    return createToolDefinition({
        name: "propose_adjustment",
        venue: "okx-swap",
        handler: async (params) => {
            const validated = params as z.infer<typeof okxAdjustmentParamsSchema>

            if (validated.stopLoss === undefined && validated.takeProfit === undefined) {
                return createRejectedExecutionToolResult("Provide stopLoss, takeProfit, or both")
            }

            const positions = await pipeline.getPositions()
            const position = positions.find((entry) => entry.instrument.toUpperCase() === validated.instrument.toUpperCase())
            if (!position) {
                return createRejectedExecutionToolResult(
                    `No open position found for ${validated.instrument.toUpperCase()}`,
                    {
                        code: "POSITION_NOT_FOUND",
                    }
                )
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
                    note: "Dry run mode: protection orders were not sent to OKX",
                }
            }

            const protectionUpdate = await venue.updateProtectionOrders({
                instrument: validated.instrument,
                stopLoss: validated.stopLoss,
                takeProfit: validated.takeProfit,
            })

            const refreshedPositions = await venue.getPositions()
            const refreshed = refreshedPositions.find((entry) => entry.instrument.toUpperCase() === validated.instrument.toUpperCase())
            const missingStopLoss = !refreshed || refreshed.stopLoss === undefined
            const missingTakeProfit = options?.requireTakeProfit === true && refreshed?.takeProfit === undefined

            if (missingStopLoss || missingTakeProfit) {
                const message = missingStopLoss
                    ? `Protection verification failed: stopLoss missing for ${validated.instrument.toUpperCase()}`
                    : `Protection verification failed: takeProfit missing for ${validated.instrument.toUpperCase()}`

                await pipeline.closePosition(
                    validated.instrument,
                    "Protection verification failed after adjustment; flattening to fail closed",
                    {
                        metadata: {
                            forcedExit: true,
                            executionSafetyCategory: missingStopLoss ? "invalid_params" : "provider_rejected",
                            executionSafetyReason: message,
                        },
                    }
                )
                await options?.onExecutionSafetyFault?.({
                    instrument: validated.instrument.toUpperCase(),
                    category: missingStopLoss ? "invalid_params" : "provider_rejected",
                    message,
                    providerPayload: JSON.stringify({
                        stopLoss: refreshed?.stopLoss,
                        takeProfit: refreshed?.takeProfit,
                    }),
                })

                const errorDetail = createExecutionErrorDetail("venue", `${message}. Position flattened to fail closed.`, {
                    code: "PROTECTION_VERIFY_FAILED",
                    retryable: false,
                })
                return {
                    status: "rejected",
                    error: formatExecutionError(errorDetail),
                    errorDetail,
                }
            }

            await options?.onExecutionSafetyRecovered?.({
                instrument: validated.instrument.toUpperCase(),
                resolutionNote: "Protection update verified from provider truth",
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

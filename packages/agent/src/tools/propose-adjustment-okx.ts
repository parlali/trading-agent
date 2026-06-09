import { z } from "zod"
import type { OKXVenueAdapter } from "@valiq-trading/okx"
import {
    createExecutionErrorDetail,
    formatExecutionError,
    getErrorMessage,
    getExecutionErrorDetail,
    type ExecutionPipeline,
} from "@valiq-trading/core"
import type { ToolBinding } from "../tool-registry"
import {
    createToolBinding,
    okxAdjustmentParamsSchema,
} from "../tool-contracts"
import { createRejectedExecutionToolResult } from "./execution-response"
import type { ExecutionSafetyToolCallbacks } from "./execution-safety"
import {
    classifyOKXProtectionFailure,
    flattenOKXPositionAfterProtectionFailure,
    type OKXProtectionFailureCategory,
} from "./okx-order-helpers"
import { assertToolNotAborted, createToolAbortError } from "../tool-registry"

export function createOKXProposeAdjustmentTool(
    pipeline: ExecutionPipeline,
    venue: OKXVenueAdapter,
    options?: ExecutionSafetyToolCallbacks & {
        dryRun?: boolean
        requireTakeProfit?: boolean
    }
): ToolBinding {
    return createToolBinding({
        name: "propose_adjustment",
        venue: "okx-swap",
        handler: async (params, context) => {
            const validated = params as z.infer<typeof okxAdjustmentParamsSchema>

            if (validated.stopLoss === undefined && validated.takeProfit === undefined) {
                return createRejectedExecutionToolResult("Provide stopLoss, takeProfit, or both")
            }

            assertToolNotAborted(context?.signal)
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

            const instrument = validated.instrument.toUpperCase()
            const requestedStopLoss = validated.stopLoss !== undefined
                ? await venue.normalizePrice(instrument, validated.stopLoss)
                : undefined
            const requestedTakeProfit = validated.takeProfit !== undefined
                ? await venue.normalizePrice(instrument, validated.takeProfit)
                : undefined
            const finalStopLoss = requestedStopLoss ?? position.stopLoss
            const finalTakeProfit = requestedTakeProfit ?? position.takeProfit

            if (finalStopLoss === undefined) {
                return createRejectedExecutionToolResult(
                    `OKX protection update for ${instrument} requires an existing or requested stopLoss`,
                    {
                        code: "STOP_LOSS_REQUIRED",
                    }
                )
            }

            if (options?.requireTakeProfit === true && finalTakeProfit === undefined) {
                return createRejectedExecutionToolResult(
                    `OKX protection update for ${instrument} requires an existing or requested takeProfit`,
                    {
                        code: "TAKE_PROFIT_REQUIRED",
                    }
                )
            }

            if (options?.dryRun) {
                return {
                    status: "updated",
                    instrument,
                    side: position.side,
                    quantity: position.quantity,
                    cancelledOrderIds: [],
                    createdOrderIds: [],
                    reason: validated.reason,
                    dryRun: true,
                    note: "Dry run mode: protection orders were not sent to OKX",
                }
            }

            const protectionIntent = {
                instrument,
                side: position.side === "long" ? "sell" as const : "buy" as const,
                quantity: position.quantity,
                orderType: finalStopLoss !== undefined && finalTakeProfit !== undefined
                    ? "stop_limit" as const
                    : finalStopLoss !== undefined
                        ? "stop" as const
                        : "limit" as const,
                stopPrice: finalStopLoss,
                limitPrice: finalTakeProfit,
                timeInForce: "gtc" as const,
                metadata: {
                    action: "modify",
                    protectionUpdate: true,
                    stopLoss: finalStopLoss,
                    takeProfit: finalTakeProfit,
                    requestedStopLoss,
                    requestedTakeProfit,
                    reason: validated.reason,
                },
            }
            const protectionContext = await pipeline.createExecutionOperationContext(
                protectionIntent,
                "modify"
            )
            assertToolNotAborted(context?.signal)
            const protectionUpdate = await updateProtectionOrdersWithRetry({
                venue,
                instrument,
                stopLoss: finalStopLoss,
                takeProfit: finalTakeProfit,
                identity: protectionContext.identity,
                signal: context?.signal,
            })

            if (!protectionUpdate.ok) {
                const failure = await flattenOKXPositionAfterProtectionFailure({
                    pipeline,
                    instrument,
                    protectionError: protectionUpdate.message,
                    category: protectionUpdate.category,
                    flattenReason: "Protection update failed; flattening to fail closed",
                    callbacks: {
                        recordFault: options?.onExecutionSafetyFault,
                        resolveFaults: options?.onExecutionSafetyRecovered,
                    },
                    providerPayload: {
                        phase: "updateProtectionOrders",
                        intendedStopLoss: finalStopLoss,
                        intendedTakeProfit: finalTakeProfit,
                        updateError: protectionUpdate.errorDetail ?? protectionUpdate.message,
                    },
                    canonicalOrderId: protectionContext.identity.canonicalOrderId,
                    providerClientOrderId: protectionContext.identity.providerClientOrderId,
                    providerOrderAliases: protectionContext.identity.providerOrderAliases,
                    submitAttemptId: protectionContext.identity.submitAttemptId,
                    submitAttemptSequence: protectionContext.identity.submitAttemptSequence,
                    venue: "okx-swap",
                })

                return createProtectionRejectedResult(failure.error, failure.category, failure.flattened)
            }

            let refreshedPositions: Awaited<ReturnType<OKXVenueAdapter["getPositions"]>>
            try {
                assertToolNotAborted(context?.signal)
                refreshedPositions = await venue.getPositions()
            } catch (error) {
                const errorDetail = getExecutionErrorDetail(error)
                const message = `Protection verification failed: provider truth read failed for ${instrument}: ${errorDetail?.message ?? getErrorMessage(error)}`
                const failure = await flattenOKXPositionAfterProtectionFailure({
                    pipeline,
                    instrument,
                    protectionError: message,
                    category: classifyOKXProtectionFailure(message),
                    flattenReason: "Protection verification failed after adjustment; flattening to fail closed",
                    callbacks: {
                        recordFault: options?.onExecutionSafetyFault,
                        resolveFaults: options?.onExecutionSafetyRecovered,
                    },
                    providerPayload: {
                        phase: "verifyProtection",
                        intendedStopLoss: finalStopLoss,
                        intendedTakeProfit: finalTakeProfit,
                        verificationError: errorDetail ?? getErrorMessage(error),
                    },
                    canonicalOrderId: protectionContext.identity.canonicalOrderId,
                    providerClientOrderId: protectionContext.identity.providerClientOrderId,
                    providerOrderAliases: protectionContext.identity.providerOrderAliases,
                    submitAttemptId: protectionContext.identity.submitAttemptId,
                    submitAttemptSequence: protectionContext.identity.submitAttemptSequence,
                    venue: "okx-swap",
                })
                return createProtectionRejectedResult(failure.error, failure.category, failure.flattened)
            }
            const refreshed = refreshedPositions.find((entry) => entry.instrument.toUpperCase() === instrument)
            const stopLossVerified = priceMatches(refreshed?.stopLoss, finalStopLoss)
            const takeProfitVerified = finalTakeProfit === undefined
                ? options?.requireTakeProfit !== true
                : priceMatches(refreshed?.takeProfit, finalTakeProfit)

            if (!stopLossVerified || !takeProfitVerified) {
                const message = !stopLossVerified
                    ? createProtectionVerificationMessage("stopLoss", instrument, requestedStopLoss !== undefined, finalStopLoss, refreshed?.stopLoss)
                    : createProtectionVerificationMessage("takeProfit", instrument, requestedTakeProfit !== undefined, finalTakeProfit, refreshed?.takeProfit)

                const category = !stopLossVerified ? "invalid_params" : "provider_rejected"
                const failure = await flattenOKXPositionAfterProtectionFailure({
                    pipeline,
                    instrument,
                    protectionError: message,
                    category,
                    flattenReason: "Protection verification failed after adjustment; flattening to fail closed",
                    callbacks: {
                        recordFault: options?.onExecutionSafetyFault,
                        resolveFaults: options?.onExecutionSafetyRecovered,
                    },
                    providerPayload: {
                        phase: "verifyProtection",
                        intendedStopLoss: finalStopLoss,
                        intendedTakeProfit: finalTakeProfit,
                        stopLoss: refreshed?.stopLoss,
                        takeProfit: refreshed?.takeProfit,
                    },
                    canonicalOrderId: protectionContext.identity.canonicalOrderId,
                    providerClientOrderId: protectionContext.identity.providerClientOrderId,
                    providerOrderAliases: protectionContext.identity.providerOrderAliases,
                    submitAttemptId: protectionContext.identity.submitAttemptId,
                    submitAttemptSequence: protectionContext.identity.submitAttemptSequence,
                    venue: "okx-swap",
                })
                return createProtectionRejectedResult(failure.error, failure.category, failure.flattened)
            }

            assertToolNotAborted(context?.signal)
            await options?.onExecutionSafetyRecovered?.({
                instrument,
                resolutionNote: "Protection update verified from provider truth",
            })

            return {
                status: "updated",
                instrument,
                side: position.side,
                quantity: position.quantity,
                cancelledOrderIds: protectionUpdate.value.cancelledOrderIds,
                createdOrderIds: protectionUpdate.value.createdOrderIds,
                reason: validated.reason,
            }
        },
    })
}

type OKXProtectionUpdateResult = Awaited<ReturnType<OKXVenueAdapter["updateProtectionOrders"]>>

async function updateProtectionOrdersWithRetry(args: {
    venue: OKXVenueAdapter
    instrument: string
    stopLoss?: number
    takeProfit?: number
    identity: Parameters<OKXVenueAdapter["updateProtectionOrders"]>[0]["identity"]
    signal?: AbortSignal
}): Promise<
    | { ok: true; value: OKXProtectionUpdateResult }
    | {
        ok: false
        category: OKXProtectionFailureCategory
        message: string
        errorDetail?: ReturnType<typeof getExecutionErrorDetail>
    }
> {
    let lastFailure: {
        category: OKXProtectionFailureCategory
        message: string
        errorDetail?: ReturnType<typeof getExecutionErrorDetail>
    } | undefined

    for (let attempt = 0; attempt < 3; attempt++) {
        assertToolNotAborted(args.signal)
        try {
            const value = await args.venue.updateProtectionOrders({
                instrument: args.instrument,
                stopLoss: args.stopLoss,
                takeProfit: args.takeProfit,
                identity: args.identity,
            })
            assertToolNotAborted(args.signal)
            return {
                ok: true,
                value,
            }
        } catch (error) {
            assertToolNotAborted(args.signal)
            const errorDetail = getExecutionErrorDetail(error)
            const message = errorDetail?.message ?? getErrorMessage(error)
            const category = classifyOKXProtectionFailure(message)
            lastFailure = {
                category,
                message,
                errorDetail,
            }

            if (category !== "position_not_found_yet" || attempt === 2) {
                break
            }

            await delay((attempt + 1) * 500, args.signal)
        }
    }

    return {
        ok: false,
        category: lastFailure?.category ?? "unknown",
        message: lastFailure?.message ?? "Failed to update OKX protection orders",
        errorDetail: lastFailure?.errorDetail,
    }
}

function createProtectionRejectedResult(
    message: string,
    category: OKXProtectionFailureCategory,
    flattened: boolean
): { status: "rejected"; error: string; errorDetail: ReturnType<typeof createExecutionErrorDetail>; protectionFailureCategory: OKXProtectionFailureCategory; flattened: boolean } {
    const errorDetail = createExecutionErrorDetail("venue", message, {
        code: flattened ? "PROTECTION_UPDATE_FAILED_CLOSED" : "PROTECTION_UPDATE_RESIDUAL_EXPOSURE",
        retryable: false,
        details: {
            protectionFailureCategory: category,
            flattened,
        },
    })

    return {
        status: "rejected",
        error: formatExecutionError(errorDetail),
        errorDetail,
        protectionFailureCategory: category,
        flattened,
    }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
    assertToolNotAborted(signal)

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort)
            resolve()
        }, ms)
        const onAbort = () => {
            clearTimeout(timer)
            reject(createToolAbortError())
        }
        signal?.addEventListener("abort", onAbort, { once: true })
    })
}

function priceMatches(actual: number | undefined, expected: number | undefined): boolean {
    if (expected === undefined) {
        return actual === undefined
    }

    return actual !== undefined && Math.abs(actual - expected) < 1e-9
}

function createProtectionVerificationMessage(
    field: "stopLoss" | "takeProfit",
    instrument: string,
    requested: boolean,
    expected: number | undefined,
    actual: number | undefined
): string {
    const source = requested ? "requested" : "existing"
    return `Protection verification failed: ${source} ${field} for ${instrument} expected ${expected ?? "<missing>"} but provider reported ${actual ?? "<missing>"}`
}

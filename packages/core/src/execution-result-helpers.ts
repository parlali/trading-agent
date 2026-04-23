import type { OrderIntent } from "./types"
import type { OrderSnapshot } from "./orders"
import type { ExecutionResult } from "./types"
import {
    createExecutionErrorDetail,
    formatExecutionError,
    getErrorMessage,
    getExecutionErrorDetail,
} from "./utils"

export function createRejectedExecutionResultFromUnknownError(
    orderId: string,
    error: unknown,
    filledQuantity: number = 0,
    fillPrice?: number
): ExecutionResult {
    const errorDetail = getExecutionErrorDetail(error) ?? createExecutionErrorDetail("internal", getErrorMessage(error))

    return {
        orderId,
        status: "rejected",
        filledQuantity,
        fillPrice,
        timestamp: Date.now(),
        error: formatExecutionError(errorDetail),
        errorDetail,
    }
}

export function mergeExecutionIntentUpdates(
    requestedChanges: Partial<OrderIntent>,
    venueUpdates: Partial<OrderIntent> | undefined
): Partial<OrderIntent> {
    return {
        ...requestedChanges,
        ...venueUpdates,
        metadata: requestedChanges.metadata || venueUpdates?.metadata
            ? {
                ...requestedChanges.metadata,
                ...venueUpdates?.metadata,
            }
            : undefined,
    }
}

export function shouldPersistModifyIntentUpdates(result: ExecutionResult): boolean {
    return (
        result.status === "pending" ||
        result.status === "partially_filled" ||
        result.status === "filled"
    )
}

export function normalizeModifyExecutionResult(
    result: ExecutionResult,
    existing: OrderSnapshot | null,
    orderId: string
): ExecutionResult {
    if (!existing) {
        return {
            ...result,
            orderId: result.orderId || orderId,
        }
    }

    const preserveExistingLifecycle = existing.status !== "pending" && existing.status !== "partially_filled"
    if (preserveExistingLifecycle) {
        return {
            ...result,
            orderId: result.orderId || orderId,
            status: existing.status,
            filledQuantity: existing.filledQuantity,
            fillPrice: existing.avgFillPrice,
        }
    }

    const preserveFilledState = existing.status === "filled" &&
        result.status === "filled" &&
        result.filledQuantity === 0 &&
        result.fillPrice === undefined

    return {
        ...result,
        orderId: result.orderId || orderId,
        status: preserveFilledState ? existing.status : result.status,
        filledQuantity: preserveFilledState
            ? existing.filledQuantity
            : result.filledQuantity,
        fillPrice: preserveFilledState
            ? existing.avgFillPrice
            : result.fillPrice ?? existing.avgFillPrice,
    }
}

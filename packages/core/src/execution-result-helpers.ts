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
    error: unknown
): ExecutionResult {
    const errorDetail = getExecutionErrorDetail(error) ?? createExecutionErrorDetail("internal", getErrorMessage(error))

    return {
        orderId,
        status: "rejected",
        filledQuantity: 0,
        timestamp: Date.now(),
        error: formatExecutionError(errorDetail),
        errorDetail,
    }
}

export function createUnconfirmedOperationFailureExecutionResult(
    orderId: string,
    error: unknown,
    existing: OrderSnapshot | null
): ExecutionResult {
    const errorDetail = getExecutionErrorDetail(error) ?? createExecutionErrorDetail("internal", getErrorMessage(error))

    return {
        orderId,
        status: existing?.status ?? "pending",
        commitOutcome: "commit_unknown",
        filledQuantity: existing?.filledQuantity ?? 0,
        fillPrice: existing?.avgFillPrice,
        timestamp: Date.now(),
        error: formatExecutionError(errorDetail),
        errorDetail,
    }
}

export function toRecoverableOperationResult(result: ExecutionResult): ExecutionResult {
    if (result.status !== "rejected") {
        return result
    }

    return {
        ...result,
        commitOutcome: "commit_unknown",
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
    if (result.commitOutcome === "commit_unknown") {
        return false
    }

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

    return {
        ...result,
        orderId: result.orderId || orderId,
        fillPrice: result.fillPrice ?? existing.avgFillPrice,
    }
}

import type { ExecutionResult, OrderSnapshot, ValidationResult } from "@valiq-trading/core"

export function toExecutionToolResult(
    result: ExecutionResult,
    options: {
        trackedOrder?: OrderSnapshot | null
        validation?: ValidationResult
    } = {}
): Record<string, unknown> {
    const payload: Record<string, unknown> = {
        orderId: result.orderId,
        status: result.status,
        filledQuantity: result.filledQuantity,
        fillPrice: result.fillPrice,
        error: result.error,
        errorDetail: result.errorDetail,
    }

    if (options.trackedOrder !== undefined) {
        payload.trackedOrder = options.trackedOrder
    }

    if (options.validation) {
        payload.riskValidation = {
            allowed: options.validation.allowed,
            reason: options.validation.reason,
        }
    }

    return payload
}

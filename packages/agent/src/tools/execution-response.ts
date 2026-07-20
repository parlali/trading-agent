import {
    createExecutionErrorDetail,
    formatExecutionError,
    type AccountState,
    type ExecutionErrorDetail,
    type ExecutionResult,
    type ExecutionPipeline,
    type OrderIntent,
    type OrderLifecycleContext,
    type OrderSnapshot,
    type Position,
    type ValidationResult,
} from "@valiq-trading/core"
import { assertToolNotAborted } from "../tool-registry"
import {
    createPlatformHardBlock,
    toModelExecutionErrorDetail,
    toModelPriceVerificationEvidence,
    type PlatformHardBlockEvidence,
} from "./tool-result-evidence"

export interface RejectedExecutionToolResult {
    orderId: string
    status: "rejected"
    filledQuantity: 0
    error: string
    errorDetail: ExecutionErrorDetail
    platformHardBlock: PlatformHardBlockEvidence
}

export function createRejectedExecutionToolResult(
    error: string,
    options: {
        code?: string
        retryable?: boolean
    } = {}
): RejectedExecutionToolResult {
    const errorDetail = createExecutionErrorDetail("pre_validation", error, {
        code: options.code,
        retryable: options.retryable ?? false,
    })

    return {
        orderId: "",
        status: "rejected",
        filledQuantity: 0,
        error: formatExecutionError(errorDetail),
        errorDetail: toModelExecutionErrorDetail(errorDetail) ?? errorDetail,
        platformHardBlock: createPlatformHardBlock("pre_validation", errorDetail.message, options.code),
    }
}

export function toExecutionToolResult(
    result: ExecutionResult,
    options: {
        trackedOrder?: OrderSnapshot | null
        validation?: ValidationResult
        extra?: Record<string, unknown>
    } = {}
): Record<string, unknown> {
    const payload: Record<string, unknown> = {
        orderId: result.orderId,
        status: result.status,
        filledQuantity: result.filledQuantity,
        fillPrice: result.fillPrice,
        error: result.error,
        errorDetail: toModelExecutionErrorDetail(result.errorDetail),
        priceVerification: toModelPriceVerificationEvidence(result.priceVerification),
    }

    if (options.trackedOrder !== undefined) {
        payload.trackedOrder = options.trackedOrder
    }

    if (options.validation && !options.validation.allowed) {
        payload.platformHardBlock = createPlatformHardBlock(
            "risk_engine",
            options.validation.reason ?? "Order rejected by risk engine"
        )
    }

    if (options.extra) {
        Object.assign(payload, options.extra)
    }

    return payload
}

export async function executeToolIntent(
    pipeline: ExecutionPipeline,
    intent: OrderIntent,
    lifecycleContext: OrderLifecycleContext,
    options: {
        includeTrackedOrder?: boolean
        account?: AccountState
        positions?: Position[]
        signal?: AbortSignal
    } = {}
): Promise<Record<string, unknown>> {
    assertToolNotAborted(options.signal)
    const [positions, account] = await Promise.all([
        options.positions ? Promise.resolve(options.positions) : pipeline.getPositions(),
        options.account ? Promise.resolve(options.account) : pipeline.getAccountState(),
    ])

    assertToolNotAborted(options.signal)
    const { result, validation, handle } = await pipeline.executeIntent(
        intent,
        account,
        positions,
        lifecycleContext
    )

    assertToolNotAborted(options.signal)
    return toExecutionToolResult(result, {
        trackedOrder: options.includeTrackedOrder ? handle?.snapshot : undefined,
        validation,
    })
}

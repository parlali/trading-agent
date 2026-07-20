import type {
    ExecutionCostAssessment,
    ExecutionCostMetrics,
    ExecutionErrorDetail,
    ExecutionErrorSource,
    PriceVerification,
} from "@valiq-trading/core"

export const PLATFORM_HARD_BLOCK_DESCRIPTION = "platform hard block - the risk engine enforces this; it is not advice"

export type PlatformHardBlockSource = ExecutionErrorSource | "price_verification"

export interface PlatformHardBlockEvidence {
    source: PlatformHardBlockSource
    reason: string
    description: typeof PLATFORM_HARD_BLOCK_DESCRIPTION
    code?: string
}

export type ExecutionCostMetricsEvidence = Omit<ExecutionCostMetrics, "liquidityWarning">

export interface ExecutionCostEvidence extends Omit<ExecutionCostAssessment, "metrics" | "status" | "blockNewEntries" | "summary"> {
    metrics: ExecutionCostMetricsEvidence
}

export interface PriceVerificationEvidence extends Omit<PriceVerification, "ok" | "status" | "message" | "executionCost"> {
    executionCost?: ExecutionCostEvidence
    platformHardBlock?: PlatformHardBlockEvidence
}

export function createPlatformHardBlock(
    source: PlatformHardBlockSource,
    reason: string,
    code?: string
): PlatformHardBlockEvidence {
    return {
        source,
        reason,
        description: PLATFORM_HARD_BLOCK_DESCRIPTION,
        code,
    }
}

export function toModelExecutionCostEvidence(
    assessment: ExecutionCostAssessment | undefined
): ExecutionCostEvidence | undefined {
    if (!assessment) {
        return undefined
    }

    const {
        metrics,
        status: _status,
        blockNewEntries: _blockNewEntries,
        summary: _summary,
        ...evidence
    } = assessment
    const {
        liquidityWarning: _liquidityWarning,
        ...metricEvidence
    } = metrics

    return {
        ...evidence,
        metrics: metricEvidence,
    }
}

export function toModelPriceVerificationEvidence(
    verification: PriceVerification | undefined
): PriceVerificationEvidence | undefined {
    if (!verification) {
        return undefined
    }

    const {
        ok,
        status,
        message,
        executionCost,
        ...evidence
    } = verification
    const platformBlocked = status === "block" || ok === false

    return {
        ...evidence,
        executionCost: toModelExecutionCostEvidence(executionCost),
        platformHardBlock: platformBlocked
            ? createPlatformHardBlock("price_verification", message, "PRICE_VERIFICATION_BLOCKED")
            : undefined,
    }
}

export function toModelExecutionErrorDetail(
    detail: ExecutionErrorDetail | undefined
): ExecutionErrorDetail | undefined {
    if (!detail) {
        return undefined
    }

    return {
        ...detail,
        details: toModelExecutionErrorDetails(detail.details),
    }
}

export function toModelMarketPriceEvidence<TMarketPrice extends {
    executionCost?: ExecutionCostAssessment
    liquidityWarning?: boolean
}>(
    marketPrice: TMarketPrice
): Omit<TMarketPrice, "executionCost" | "liquidityWarning"> & { executionCost?: ExecutionCostEvidence } {
    const {
        executionCost,
        liquidityWarning: _liquidityWarning,
        ...evidence
    } = marketPrice

    return {
        ...evidence,
        executionCost: toModelExecutionCostEvidence(executionCost),
    }
}

function toModelExecutionErrorDetails(
    details: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
    if (!details) {
        return undefined
    }

    const priceVerification = details.priceVerification

    if (!isPriceVerification(priceVerification)) {
        return details
    }

    return {
        ...details,
        priceVerification: toModelPriceVerificationEvidence(priceVerification),
    }
}

function isPriceVerification(value: unknown): value is PriceVerification {
    return value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        "livePrices" in value &&
        "ok" in value
}

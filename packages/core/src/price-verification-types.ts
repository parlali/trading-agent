import type { ExecutionCostAssessment } from "./execution-cost"
import type { OrderIntent } from "./order-intent-types"

export const PRICE_VERIFICATION_STATUSES = ["pass", "warn", "block", "skipped"] as const
export type PriceVerificationStatus = typeof PRICE_VERIFICATION_STATUSES[number]

export interface PriceVerificationLivePrices {
    bid?: number
    ask?: number
    mid?: number
    spread?: number
}

export interface PriceVerification {
    ok: boolean
    status?: PriceVerificationStatus
    livePrices: PriceVerificationLivePrices
    proposedPrice?: number
    drift?: number
    driftPercent?: number
    executionCost?: ExecutionCostAssessment
    warningThresholdPercent?: number
    blockingThresholdPercent?: number
    message: string
    details?: Record<string, unknown>
}

export interface PriceVerifier {
    verify(intent: OrderIntent): Promise<PriceVerification>
}

export interface PriceVerificationConfig {
    warningThresholdPercent?: number
    blockingThresholdPercent?: number
    failClosedOnVerificationError?: boolean
}

export type ResolvedPriceVerificationConfig = Required<PriceVerificationConfig>

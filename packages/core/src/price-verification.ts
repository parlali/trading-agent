import type { ExecutionCostAssessment } from "./execution-cost"
import type { OrderIntent } from "./types"

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

const DEFAULT_PRICE_VERIFICATION_CONFIG: ResolvedPriceVerificationConfig = {
    warningThresholdPercent: 10,
    blockingThresholdPercent: 20,
    failClosedOnVerificationError: false,
}

export function resolvePriceVerificationConfig(
    config: PriceVerificationConfig | undefined
): ResolvedPriceVerificationConfig {
    const warningThresholdPercent = config?.warningThresholdPercent ?? DEFAULT_PRICE_VERIFICATION_CONFIG.warningThresholdPercent
    const blockingThresholdPercent = config?.blockingThresholdPercent ?? DEFAULT_PRICE_VERIFICATION_CONFIG.blockingThresholdPercent

    return {
        warningThresholdPercent,
        blockingThresholdPercent: Math.max(blockingThresholdPercent, warningThresholdPercent),
        failClosedOnVerificationError: config?.failClosedOnVerificationError ?? DEFAULT_PRICE_VERIFICATION_CONFIG.failClosedOnVerificationError,
    }
}

export function finalizePriceVerification(
    verification: PriceVerification,
    config: ResolvedPriceVerificationConfig,
    options: {
        riskReducing: boolean
    }
): PriceVerification {
    const driftPercent = typeof verification.driftPercent === "number"
        ? Math.abs(verification.driftPercent)
        : undefined
    const executionCostStatus = verification.executionCost?.status
    const executionCostBlocks = verification.executionCost?.blockNewEntries === true && !options.riskReducing
    const executionCostWarns = executionCostStatus === "elevated"

    let status = verification.status ?? "pass"
    let ok = verification.ok

    if (!ok || status === "block") {
        status = "block"
        ok = false
    } else if (executionCostBlocks) {
        status = "block"
        ok = false
    } else if (driftPercent !== undefined && driftPercent > config.blockingThresholdPercent) {
        status = "block"
        ok = false
    } else if (
        status !== "warn" &&
        executionCostWarns
    ) {
        status = "warn"
        ok = true
    } else if (
        status !== "warn" &&
        driftPercent !== undefined &&
        driftPercent > config.warningThresholdPercent
    ) {
        status = "warn"
        ok = true
    }

    return {
        ...verification,
        ok,
        status,
        driftPercent,
        warningThresholdPercent: config.warningThresholdPercent,
        blockingThresholdPercent: config.blockingThresholdPercent,
        message: buildPriceVerificationMessage(
            verification,
            driftPercent,
            status,
            config,
            options
        ),
    }
}

export function resolveIntentProposedPrice(intent: OrderIntent): number | undefined {
    if (typeof intent.limitPrice === "number") {
        return intent.limitPrice
    }

    if (typeof intent.stopPrice === "number") {
        return intent.stopPrice
    }

    const estimatedPrice = intent.metadata?.estimatedPrice
    return typeof estimatedPrice === "number" ? estimatedPrice : undefined
}

function buildPriceVerificationMessage(
    verification: PriceVerification,
    driftPercent: number | undefined,
    status: PriceVerificationStatus,
    config: ResolvedPriceVerificationConfig,
    options: {
        riskReducing: boolean
    }
): string {
    if (driftPercent === undefined) {
        if (verification.executionCost?.blockNewEntries === true && !options.riskReducing) {
            return `Blocked by execution-cost validation: ${verification.executionCost.summary}`
        }

        if (verification.executionCost?.status === "elevated") {
            return `Execution-cost warning: ${verification.executionCost.summary}`
        }

        return verification.message
    }

    const proposedPrice = verification.proposedPrice
    const liveMid = verification.livePrices.mid
    const drift = verification.drift

    if (verification.status === "block" || verification.ok === false) {
        return verification.message
    }

    const liveText = liveMid !== undefined ? `live mid ${liveMid}` : "live midpoint unavailable"
    const proposedText = proposedPrice !== undefined ? `proposed price ${proposedPrice}` : "no proposed price"
    const driftText = drift !== undefined ? `drift ${drift}` : "drift unavailable"
    const executionCostText = verification.executionCost?.summary

    if (verification.executionCost?.blockNewEntries === true && !options.riskReducing) {
        return `Blocked by execution-cost validation: ${verification.executionCost.summary}`
    }

    if (status === "block") {
        return `Blocked by price verification: ${proposedText}, ${liveText}, ${driftText}, drift ${driftPercent.toFixed(2)}% exceeds ${config.blockingThresholdPercent}%`
    }

    if (status === "warn") {
        const reasons: string[] = []
        if (driftPercent > config.warningThresholdPercent) {
            reasons.push(`drift ${driftPercent.toFixed(2)}% exceeds ${config.warningThresholdPercent}%`)
        }
        if (verification.executionCost?.status === "elevated" && executionCostText) {
            reasons.push(executionCostText)
        }

        return `Price verification warning: ${proposedText}, ${liveText}, ${driftText}, ${reasons.join("; ")}`
    }

    const suffix = executionCostText ? `, execution cost ${executionCostText}` : ""
    return `Price verification passed: ${proposedText}, ${liveText}, ${driftText}, drift ${driftPercent.toFixed(2)}%${suffix}`
}

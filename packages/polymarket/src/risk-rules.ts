import {
    allowWithGateEvaluation,
    allowWithGateEvaluations,
    createGateEvaluation,
    getRiskBudgetBase,
    isDryRunAccountLedgerPosition,
    openIntentRiskValidator,
    polymarketPolicySchema,
    readFiniteNumber,
    readTrimmedString,
    rejectRiskWithGateEvaluation,
    rejectRiskWithGateEvaluations,
    type AccountState,
    type OrderIntent,
    type Position,
    type RiskValidator,
} from "@valiq-trading/core"
import { getPolymarketOrderSemanticsError } from "./order-semantics"

function canonicalIdentityValidator(
    intent: OrderIntent
): { allowed: boolean; reason?: string } {
    const metadata = intent.metadata ?? {}
    const tokenId = readTrimmedString(metadata.tokenId)
    const conditionId = readTrimmedString(metadata.conditionId)
    const marketSlug = readTrimmedString(metadata.marketSlug)
    const question = readTrimmedString(metadata.question)
    const outcome = readTrimmedString(metadata.outcome)

    if (!tokenId || tokenId !== intent.instrument || !conditionId || !marketSlug || !question || !outcome) {
        return {
            allowed: false,
            reason: "Polymarket orders require canonical tokenId, conditionId, marketSlug, question, and outcome from broker discovery",
        }
    }

    return { allowed: true }
}

function supportedOrderSemanticsValidator(
    intent: OrderIntent
): { allowed: boolean; reason?: string } {
    const reason = getPolymarketOrderSemanticsError(intent)
    if (reason) {
        return {
            allowed: false,
            reason,
        }
    }

    return { allowed: true }
}

function maxBetValidator(
    intent: OrderIntent,
    rawPolicy: Record<string, unknown>,
    state: AccountState,
    _positions: Position[]
): { allowed: boolean; reason?: string } {
    const policy = polymarketPolicySchema.parse(rawPolicy)

    if (intent.side === "sell") {
        return { allowed: true }
    }

    const price = resolveIntentPrice(intent)
    const intentCost = intent.quantity * price

    let maxAllowed: number

    if (policy.maxBet.mode === "fixed") {
        maxAllowed = policy.maxBet.value
    } else {
        maxAllowed = (policy.maxBet.value / 100) * getRiskBudgetBase(state)
    }

    const gateEvaluation = createGateEvaluation({
        gateKey: "polymarket.maxBet",
        observed: intentCost,
        threshold: maxAllowed,
        comparison: "max",
    })

    if (intentCost > maxAllowed) {
        const modeLabel = policy.maxBet.mode === "fixed"
            ? `$${policy.maxBet.value}`
            : `${policy.maxBet.value}% of balance ($${maxAllowed.toFixed(2)})`

        return rejectRiskWithGateEvaluation(
            `Bet cost $${intentCost.toFixed(2)} exceeds max bet ${modeLabel}`,
            gateEvaluation
        )
    }

    return allowWithGateEvaluation(gateEvaluation)
}

const PRICE_LOWER_BOUND = 0.02
const PRICE_UPPER_BOUND = 0.82

function priceBoundsValidator(
    intent: OrderIntent
): { allowed: boolean; reason?: string } {
    if (intent.side === "sell") {
        return { allowed: true }
    }

    const price = resolveIntentPrice(intent)
    if (price <= 0) {
        return { allowed: true }
    }

    const lowerGateEvaluation = createGateEvaluation({
        gateKey: "polymarket.priceLowerBound",
        observed: price,
        threshold: PRICE_LOWER_BOUND,
        comparison: "min",
    })

    if (price < PRICE_LOWER_BOUND) {
        return rejectRiskWithGateEvaluation(
            `Buy price ${price} is below the safety floor ${PRICE_LOWER_BOUND} -- near-zero probability markets carry extreme risk`,
            lowerGateEvaluation
        )
    }

    const upperGateEvaluation = createGateEvaluation({
        gateKey: "polymarket.priceUpperBound",
        observed: price,
        threshold: PRICE_UPPER_BOUND,
        comparison: "max",
    })

    if (price > PRICE_UPPER_BOUND) {
        return rejectRiskWithGateEvaluations(
            `Buy price ${price} exceeds the safety ceiling ${PRICE_UPPER_BOUND} -- near-certain markets offer minimal upside`,
            [lowerGateEvaluation, upperGateEvaluation]
        )
    }

    return allowWithGateEvaluations([lowerGateEvaluation, upperGateEvaluation])
}

function liquidityValidator(
    intent: OrderIntent,
    rawPolicy: Record<string, unknown>
): { allowed: boolean; reason?: string } {
    if (intent.side === "sell") {
        return { allowed: true }
    }

    const policy = polymarketPolicySchema.parse(rawPolicy)
    if (policy.minLiquidity <= 0) {
        return { allowed: true }
    }

    const liquidity = readFiniteNumber(intent.metadata?.liquidity)
    if (liquidity === undefined) {
        return {
            allowed: false,
            reason: `Polymarket liquidity is required because policy minLiquidity is ${policy.minLiquidity}`,
        }
    }

    const gateEvaluation = createGateEvaluation({
        gateKey: "polymarket.minLiquidity",
        observed: liquidity,
        threshold: policy.minLiquidity,
        comparison: "min",
    })

    if (liquidity < policy.minLiquidity) {
        return rejectRiskWithGateEvaluation(
            `Polymarket liquidity ${liquidity} is below policy minimum ${policy.minLiquidity}`,
            gateEvaluation
        )
    }

    return allowWithGateEvaluation(gateEvaluation)
}

function resolutionBufferValidator(
    intent: OrderIntent,
    rawPolicy: Record<string, unknown>
): { allowed: boolean; reason?: string } {
    if (intent.side === "sell") {
        return { allowed: true }
    }

    const policy = polymarketPolicySchema.parse(rawPolicy)
    if (policy.minResolutionBufferHours <= 0) {
        return { allowed: true }
    }

    const endDateIso = readTrimmedString(intent.metadata?.endDateIso)
    if (!endDateIso) {
        return {
            allowed: false,
            reason: `Polymarket resolution date is required because policy minResolutionBufferHours is ${policy.minResolutionBufferHours}`,
        }
    }

    const endAt = Date.parse(endDateIso)
    if (!Number.isFinite(endAt)) {
        return {
            allowed: false,
            reason: `Polymarket resolution date ${endDateIso} is invalid`,
        }
    }

    const hoursUntilResolution = (endAt - Date.now()) / (60 * 60 * 1000)
    const gateEvaluation = createGateEvaluation({
        gateKey: "polymarket.minResolutionBufferHours",
        observed: hoursUntilResolution,
        threshold: policy.minResolutionBufferHours,
        comparison: "min",
    })

    if (hoursUntilResolution < policy.minResolutionBufferHours) {
        return rejectRiskWithGateEvaluation(
            `Polymarket market resolves in ${hoursUntilResolution.toFixed(1)}h, below policy buffer ${policy.minResolutionBufferHours}h`,
            gateEvaluation
        )
    }

    return allowWithGateEvaluation(gateEvaluation)
}

function categoryAllowlistValidator(
    intent: OrderIntent,
    rawPolicy: Record<string, unknown>
): { allowed: boolean; reason?: string } {
    if (intent.side === "sell") {
        return { allowed: true }
    }

    const policy = polymarketPolicySchema.parse(rawPolicy)
    if (policy.allowedCategories.length === 0) {
        return { allowed: true }
    }

    const category = readTrimmedString(intent.metadata?.category)?.toLowerCase()
    const allowed = new Set(policy.allowedCategories.map((entry) => entry.toLowerCase()))
    if (!category || !allowed.has(category)) {
        return {
            allowed: false,
            reason: `Polymarket category ${category ?? "unknown"} is outside the policy allowlist`,
        }
    }

    return { allowed: true }
}

function totalExposureValidator(
    intent: OrderIntent,
    rawPolicy: Record<string, unknown>,
    _state: AccountState,
    positions: Position[]
): { allowed: boolean; reason?: string } {
    if (intent.side === "sell") {
        return { allowed: true }
    }

    const policy = polymarketPolicySchema.parse(rawPolicy)
    if (policy.maxTotalExposure === undefined) {
        return { allowed: true }
    }

    const existingExposure = positions.reduce(
        (sum, position) => sum + position.quantity * position.entryPrice,
        0
    )
    const newExposure = intent.quantity * resolveIntentPrice(intent)
    const totalExposure = existingExposure + newExposure
    const gateEvaluation = createGateEvaluation({
        gateKey: "polymarket.maxTotalExposure",
        observed: totalExposure,
        threshold: policy.maxTotalExposure,
        comparison: "max",
    })

    if (totalExposure > policy.maxTotalExposure) {
        return rejectRiskWithGateEvaluation(
            `Polymarket total exposure ${totalExposure.toFixed(2)} exceeds policy maximum ${policy.maxTotalExposure}`,
            gateEvaluation
        )
    }

    return allowWithGateEvaluation(gateEvaluation)
}

const maxEntryPriceValidator: RiskValidator = openIntentRiskValidator((
    intent: OrderIntent,
    rawPolicy: Record<string, unknown>
): { allowed: boolean; reason?: string } => {
    const policy = polymarketPolicySchema.parse(rawPolicy)
    if (policy.maxEntryPrice === undefined || intent.side !== "buy") {
        return { allowed: true }
    }

    const price = intent.limitPrice ?? readFiniteNumber(intent.metadata?.estimatedPrice)
    if (price === undefined) {
        return {
            allowed: false,
            reason: `Entry price is required because the strategy maximum entry price is ${policy.maxEntryPrice.toFixed(2)}`,
        }
    }

    const gateEvaluation = createGateEvaluation({
        gateKey: "polymarket.maxEntryPrice",
        observed: price,
        threshold: policy.maxEntryPrice,
        comparison: "max",
    })

    if (price > policy.maxEntryPrice) {
        return rejectRiskWithGateEvaluation(
            `Entry price ${price.toFixed(2)} exceeds the maximum entry price ${policy.maxEntryPrice.toFixed(2)} for this strategy. The last cents of a longshot fade are not the edge.`,
            gateEvaluation
        )
    }

    return allowWithGateEvaluation(gateEvaluation)
})

const maxConcurrentPositionsValidator: RiskValidator = openIntentRiskValidator((
    intent: OrderIntent,
    rawPolicy: Record<string, unknown>,
    _state: AccountState,
    positions: Position[]
): { allowed: boolean; reason?: string } => {
    const policy = polymarketPolicySchema.parse(rawPolicy)
    if (policy.maxConcurrentPositions === undefined || intent.side !== "buy") {
        return { allowed: true }
    }

    const activePositions = positions.filter((position) =>
        !isDryRunAccountLedgerPosition(position) &&
        !isExpectedExternalPosition(position)
    )
    const alreadyHeld = activePositions.some((position) => position.instrument === intent.instrument)
    if (alreadyHeld) {
        return { allowed: true }
    }

    const gateEvaluation = createGateEvaluation({
        gateKey: "polymarket.maxConcurrentPositions",
        observed: activePositions.length + 1,
        threshold: policy.maxConcurrentPositions,
        comparison: "max",
    })

    if (activePositions.length >= policy.maxConcurrentPositions) {
        return rejectRiskWithGateEvaluation(
            `Position cap reached: ${activePositions.length} of ${policy.maxConcurrentPositions} concurrent positions. Close something before opening a new market.`,
            gateEvaluation
        )
    }

    return allowWithGateEvaluation(gateEvaluation)
})

function isExpectedExternalPosition(position: Position): boolean {
    const portfolioPosition = position as Position & { expectedExternal?: boolean }
    if (portfolioPosition.expectedExternal === true) {
        return true
    }

    return position.metadata?.expectedExternal === true
}

export const polymarketRiskValidators: readonly RiskValidator[] = [
    canonicalIdentityValidator,
    supportedOrderSemanticsValidator,
    maxBetValidator,
    priceBoundsValidator,
    liquidityValidator,
    resolutionBufferValidator,
    categoryAllowlistValidator,
    totalExposureValidator,
    maxEntryPriceValidator,
    maxConcurrentPositionsValidator,
]

function resolveIntentPrice(intent: OrderIntent): number {
    return intent.limitPrice ??
        readFiniteNumber(intent.metadata?.estimatedPrice) ??
        readFiniteNumber(intent.metadata?.currentPrice) ??
        0
}

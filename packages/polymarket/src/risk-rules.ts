import {
    getRiskBudgetBase,
    polymarketPolicySchema,
    readFiniteNumber,
    readTrimmedString,
    type AccountState,
    type OrderIntent,
    type Position,
    type RiskValidator,
} from "@valiq-trading/core"

export const polymarketRiskValidators: readonly RiskValidator[] = [
    canonicalIdentityValidator,
    maxBetValidator,
    priceBoundsValidator,
    liquidityValidator,
    resolutionBufferValidator,
    categoryAllowlistValidator,
    totalExposureValidator,
]

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

    if (intentCost > maxAllowed) {
        const modeLabel = policy.maxBet.mode === "fixed"
            ? `$${policy.maxBet.value}`
            : `${policy.maxBet.value}% of balance ($${maxAllowed.toFixed(2)})`

        return {
            allowed: false,
            reason: `Bet cost $${intentCost.toFixed(2)} exceeds max bet ${modeLabel}`,
        }
    }

    return { allowed: true }
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

    if (price < PRICE_LOWER_BOUND) {
        return {
            allowed: false,
            reason: `Buy price ${price} is below the safety floor ${PRICE_LOWER_BOUND} -- near-zero probability markets carry extreme risk`,
        }
    }

    if (price > PRICE_UPPER_BOUND) {
        return {
            allowed: false,
            reason: `Buy price ${price} exceeds the safety ceiling ${PRICE_UPPER_BOUND} -- near-certain markets offer minimal upside`,
        }
    }

    return { allowed: true }
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

    if (liquidity < policy.minLiquidity) {
        return {
            allowed: false,
            reason: `Polymarket liquidity ${liquidity} is below policy minimum ${policy.minLiquidity}`,
        }
    }

    return { allowed: true }
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
    if (hoursUntilResolution < policy.minResolutionBufferHours) {
        return {
            allowed: false,
            reason: `Polymarket market resolves in ${hoursUntilResolution.toFixed(1)}h, below policy buffer ${policy.minResolutionBufferHours}h`,
        }
    }

    return { allowed: true }
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

    if (totalExposure > policy.maxTotalExposure) {
        return {
            allowed: false,
            reason: `Polymarket total exposure ${totalExposure.toFixed(2)} exceeds policy maximum ${policy.maxTotalExposure}`,
        }
    }

    return { allowed: true }
}

function resolveIntentPrice(intent: OrderIntent): number {
    return intent.limitPrice ??
        readFiniteNumber(intent.metadata?.estimatedPrice) ??
        readFiniteNumber(intent.metadata?.currentPrice) ??
        0
}

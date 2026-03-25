import {
    polymarketPolicySchema,
    type AccountState,
    type OrderIntent,
    type Position,
    type RiskValidator,
} from "@valiq-trading/core"

export const polymarketRiskValidators: readonly RiskValidator[] = [
    maxPositionSizeValidator,
    maxTotalExposureValidator,
    allowedCategoriesValidator,
    minLiquidityValidator,
    priceBoundsValidator,
]

// ---------------------------------------------------------------------------
// Max position size per market
// ---------------------------------------------------------------------------

function maxPositionSizeValidator(
    intent: OrderIntent,
    rawPolicy: Record<string, unknown>,
    _state: AccountState,
    positions: Position[]
): { allowed: boolean; reason?: string } {
    const policy = polymarketPolicySchema.parse(rawPolicy)

    // Skip check for sells (closing positions)
    if (intent.side === "sell") {
        return { allowed: true }
    }

    const price = intent.limitPrice ?? 0
    const intentCost = intent.quantity * price

    // Sum existing exposure in the same market/token
    const existingExposure = positions
        .filter((pos) => pos.instrument === intent.instrument)
        .reduce((sum, pos) => sum + pos.quantity * pos.entryPrice, 0)

    const totalPositionSize = existingExposure + intentCost

    if (totalPositionSize > policy.maxPositionSize) {
        return {
            allowed: false,
            reason: `Position size ${totalPositionSize.toFixed(2)} USDC would exceed max ${policy.maxPositionSize} per market (existing: ${existingExposure.toFixed(2)}, new: ${intentCost.toFixed(2)})`,
        }
    }

    return { allowed: true }
}

// ---------------------------------------------------------------------------
// Max total exposure across all markets
// ---------------------------------------------------------------------------

function maxTotalExposureValidator(
    intent: OrderIntent,
    rawPolicy: Record<string, unknown>,
    _state: AccountState,
    positions: Position[]
): { allowed: boolean; reason?: string } {
    const policy = polymarketPolicySchema.parse(rawPolicy)

    if (intent.side === "sell") {
        return { allowed: true }
    }

    const currentExposure = positions.reduce(
        (sum, pos) => sum + pos.quantity * pos.entryPrice,
        0
    )

    const price = intent.limitPrice ?? 0
    const newExposure = intent.quantity * price
    const totalExposure = currentExposure + newExposure

    if (totalExposure > policy.maxTotalExposure) {
        return {
            allowed: false,
            reason: `Total exposure ${totalExposure.toFixed(2)} USDC would exceed max ${policy.maxTotalExposure} (current: ${currentExposure.toFixed(2)}, new: ${newExposure.toFixed(2)})`,
        }
    }

    return { allowed: true }
}

// ---------------------------------------------------------------------------
// Allowed categories whitelist
// ---------------------------------------------------------------------------

function allowedCategoriesValidator(
    intent: OrderIntent,
    rawPolicy: Record<string, unknown>
): { allowed: boolean; reason?: string } {
    const policy = polymarketPolicySchema.parse(rawPolicy)

    if (!policy.allowedCategories || policy.allowedCategories.length === 0) {
        return { allowed: true }
    }

    const category = intent.metadata?.category as string | undefined

    if (!category) {
        // If the intent doesn't carry category metadata, allow it
        // The agent should attach category when proposing orders
        return { allowed: true }
    }

    const normalizedCategory = category.toLowerCase()
    const allowed = policy.allowedCategories.some(
        (c) => c.toLowerCase() === normalizedCategory
    )

    if (!allowed) {
        return {
            allowed: false,
            reason: `Category "${category}" is not in the allowed categories list: ${policy.allowedCategories.join(", ")}`,
        }
    }

    return { allowed: true }
}

// ---------------------------------------------------------------------------
// Minimum liquidity threshold
// ---------------------------------------------------------------------------

function minLiquidityValidator(
    intent: OrderIntent,
    rawPolicy: Record<string, unknown>
): { allowed: boolean; reason?: string } {
    const policy = polymarketPolicySchema.parse(rawPolicy)

    if (!policy.minLiquidity || policy.minLiquidity <= 0) {
        return { allowed: true }
    }

    const liquidity = intent.metadata?.liquidity as number | undefined

    if (liquidity === undefined) {
        // If liquidity metadata is not attached, allow the order
        // The agent should check liquidity before proposing orders
        return { allowed: true }
    }

    if (liquidity < policy.minLiquidity) {
        return {
            allowed: false,
            reason: `Market liquidity ${liquidity.toFixed(2)} is below minimum threshold ${policy.minLiquidity}`,
        }
    }

    return { allowed: true }
}

// ---------------------------------------------------------------------------
// Price bounds — reject orders at extreme probabilities
// ---------------------------------------------------------------------------

const PRICE_LOWER_BOUND = 0.02
const PRICE_UPPER_BOUND = 0.98

function priceBoundsValidator(
    intent: OrderIntent
): { allowed: boolean; reason?: string } {
    if (intent.side === "sell") {
        return { allowed: true }
    }

    const price = intent.limitPrice
    if (price === undefined || price <= 0) {
        return { allowed: true }
    }

    if (price < PRICE_LOWER_BOUND) {
        return {
            allowed: false,
            reason: `Buy price ${price} is below the safety floor ${PRICE_LOWER_BOUND} — near-zero probability markets carry extreme risk`,
        }
    }

    if (price > PRICE_UPPER_BOUND) {
        return {
            allowed: false,
            reason: `Buy price ${price} exceeds the safety ceiling ${PRICE_UPPER_BOUND} — near-certain markets offer minimal upside`,
        }
    }

    return { allowed: true }
}

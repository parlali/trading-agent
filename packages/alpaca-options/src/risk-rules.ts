import {
    alpacaOptionsPolicySchema,
    type AccountState,
    type OrderIntent,
    type Position,
    type RiskValidator,
} from "@valiq-trading/core"

interface ParsedOptionContract {
    underlying: string
    expiration: string
    optionType: "call" | "put"
    strike: number
}

export const alpacaRiskValidators: readonly RiskValidator[] = [
    maxLossPerPlayValidator,
    expiryValidationValidator,
    spreadWidthValidationValidator,
]

export function parseOptionContractSymbol(symbol: string): ParsedOptionContract | null {
    const normalized = symbol.trim().toUpperCase()
    if (normalized.length < 15) {
        return null
    }

    const suffix = normalized.slice(-15)
    const underlying = normalized.slice(0, -15).trim()
    const datePart = suffix.slice(0, 6)
    const typePart = suffix.slice(6, 7)
    const strikePart = suffix.slice(7)

    if (!/^\d{6}$/.test(datePart) || !/^\d{8}$/.test(strikePart) || (typePart !== "C" && typePart !== "P")) {
        return null
    }

    const year = `20${datePart.slice(0, 2)}`
    const month = datePart.slice(2, 4)
    const day = datePart.slice(4, 6)

    return {
        underlying,
        expiration: `${year}-${month}-${day}`,
        optionType: typePart === "C" ? "call" : "put",
        strike: Number(strikePart) / 1000,
    }
}

function maxLossPerPlayValidator(
    intent: OrderIntent,
    rawPolicy: Record<string, unknown>,
    _state: AccountState,
    _positions: Position[]
) {
    const policy = alpacaOptionsPolicySchema.parse(rawPolicy)
    const estimatedMaxLoss = estimateStructureMaxLoss(intent)

    if (estimatedMaxLoss === null) {
        return {
            allowed: false,
            reason: "Unable to determine max loss for Alpaca options structure",
        }
    }

    if (estimatedMaxLoss > policy.maxLossPerPlay) {
        return {
            allowed: false,
            reason: `Estimated max loss ${estimatedMaxLoss} exceeds limit ${policy.maxLossPerPlay}`,
        }
    }

    return { allowed: true }
}

function expiryValidationValidator(intent: OrderIntent) {
    const expirations = getIntentExpirations(intent)

    if (expirations.length === 0) {
        return {
            allowed: false,
            reason: "Unable to determine option expiration for Alpaca multi-leg order",
        }
    }

    const uniqueExpirations = new Set(expirations)
    if (uniqueExpirations.size !== 1) {
        return {
            allowed: false,
            reason: "All legs in an Alpaca options structure must share the same expiration",
        }
    }

    const expectedExpiration = intent.metadata?.expectedExpiration
    if (typeof expectedExpiration === "string" && !uniqueExpirations.has(expectedExpiration)) {
        return {
            allowed: false,
            reason: `Order expiration ${expirations[0]} does not match expected expiration ${expectedExpiration}`,
        }
    }

    const targetDaysToExpiry = intent.metadata?.targetDaysToExpiry
    if (typeof targetDaysToExpiry === "number") {
        const actualDays = diffDays(expirations[0] ?? "")
        if (actualDays === null || actualDays !== targetDaysToExpiry) {
            return {
                allowed: false,
                reason: `Order expiration is ${actualDays ?? "unknown"} DTE but strategy expects ${targetDaysToExpiry} DTE`,
            }
        }
    }

    return { allowed: true }
}

function spreadWidthValidationValidator(
    intent: OrderIntent,
    rawPolicy: Record<string, unknown>
) {
    const policy = alpacaOptionsPolicySchema.parse(rawPolicy)
    const width = calculateStructureWidth(intent)

    if (width === null) {
        return {
            allowed: false,
            reason: "Unable to determine spread width for Alpaca options structure",
        }
    }

    const maxLossFromWidth = width * 100 * intent.quantity

    if (maxLossFromWidth > policy.maxLossPerPlay) {
        return {
            allowed: false,
            reason: `Spread width implies max loss ${maxLossFromWidth}, exceeding ${policy.maxLossPerPlay}`,
        }
    }

    return { allowed: true }
}

function getIntentExpirations(intent: OrderIntent): string[] {
    if (!intent.legs || intent.legs.length === 0) {
        return []
    }

    return intent.legs
        .map((leg) => parseOptionContractSymbol(leg.instrument)?.expiration)
        .filter((value): value is string => Boolean(value))
}

function calculateStructureWidth(intent: OrderIntent): number | null {
    const parsedLegs = (intent.legs ?? [])
        .map((leg) => parseOptionContractSymbol(leg.instrument))
        .filter((value): value is ParsedOptionContract => Boolean(value))

    if (parsedLegs.length < 4) {
        const metadataWidth = intent.metadata?.spreadWidth
        return typeof metadataWidth === "number" ? metadataWidth : null
    }

    const callStrikes = parsedLegs.filter((leg) => leg.optionType === "call").map((leg) => leg.strike).sort((left, right) => left - right)
    const putStrikes = parsedLegs.filter((leg) => leg.optionType === "put").map((leg) => leg.strike).sort((left, right) => left - right)

    const callWidth = callStrikes.length >= 2 ? callStrikes[callStrikes.length - 1]! - callStrikes[0]! : 0
    const putWidth = putStrikes.length >= 2 ? putStrikes[putStrikes.length - 1]! - putStrikes[0]! : 0
    const width = Math.max(callWidth, putWidth)

    return width > 0 ? width : null
}

function estimateStructureMaxLoss(intent: OrderIntent): number | null {
    const explicitMaxLoss = intent.metadata?.maxLoss
    if (typeof explicitMaxLoss === "number") {
        return explicitMaxLoss
    }

    const width = calculateStructureWidth(intent)
    if (width === null) {
        return null
    }

    const credit = intent.limitPrice ?? 0
    const grossRisk = width * 100 * intent.quantity
    const creditOffset = credit * 100 * intent.quantity

    return Math.max(grossRisk - creditOffset, 0)
}

function diffDays(expiration: string): number | null {
    const expirationAt = new Date(`${expiration}T00:00:00Z`)
    if (Number.isNaN(expirationAt.getTime())) {
        return null
    }

    const difference = expirationAt.getTime() - Date.now()
    return Math.round(difference / 86_400_000)
}

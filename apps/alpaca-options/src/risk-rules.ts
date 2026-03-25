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
    maxLossPerStructureValidator,
    maxConcurrentStructuresValidator,
    allowedUnderlyingsValidator,
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

function maxLossPerStructureValidator(
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

    if (estimatedMaxLoss > policy.maxLossPerStructure) {
        return {
            allowed: false,
            reason: `Estimated max loss ${estimatedMaxLoss} exceeds structure limit ${policy.maxLossPerStructure}`,
        }
    }

    return { allowed: true }
}

function maxConcurrentStructuresValidator(
    intent: OrderIntent,
    rawPolicy: Record<string, unknown>,
    _state: AccountState,
    positions: Position[]
) {
    const policy = alpacaOptionsPolicySchema.parse(rawPolicy)

    if ((intent.metadata?.action as string | undefined) === "close") {
        return { allowed: true }
    }

    const openStructureCount = positions.reduce((count, position) => {
        const structureType = position.metadata?.structureType
        if (structureType === "iron_condor") {
            return count + Math.max(position.quantity, 1)
        }
        return count + 1
    }, 0)

    if (openStructureCount >= policy.maxConcurrentStructures) {
        return {
            allowed: false,
            reason: `Opening another structure would exceed max concurrent structures ${policy.maxConcurrentStructures}`,
        }
    }

    return { allowed: true }
}

function allowedUnderlyingsValidator(
    intent: OrderIntent,
    rawPolicy: Record<string, unknown>
) {
    const policy = alpacaOptionsPolicySchema.parse(rawPolicy)
    const underlyings = getIntentUnderlyings(intent)

    if (underlyings.length === 0) {
        return {
            allowed: false,
            reason: "Unable to determine underlying for Alpaca options order",
        }
    }

    for (const underlying of underlyings) {
        if (!policy.allowedUnderlyings.includes(underlying)) {
            return {
                allowed: false,
                reason: `Underlying ${underlying} is not in the allowed underlyings list`,
            }
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

    if (maxLossFromWidth > policy.maxLossPerStructure) {
        return {
            allowed: false,
            reason: `Spread width implies max loss ${maxLossFromWidth}, exceeding ${policy.maxLossPerStructure}`,
        }
    }

    return { allowed: true }
}

function getIntentUnderlyings(intent: OrderIntent): string[] {
    const explicitUnderlying = intent.metadata?.underlying
    if (typeof explicitUnderlying === "string") {
        return [explicitUnderlying.toUpperCase()]
    }

    const instruments = [intent.instrument, ...(intent.legs?.map((leg) => leg.instrument) ?? [])]
    const underlyings = instruments
        .map((instrument) => parseOptionContractSymbol(instrument)?.underlying ?? extractUnderlyingFromSyntheticInstrument(instrument))
        .filter((value): value is string => Boolean(value))

    return Array.from(new Set(underlyings))
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

function extractUnderlyingFromSyntheticInstrument(instrument: string): string | null {
    if (!instrument.startsWith("IC:")) {
        return null
    }

    const parts = instrument.split(":")
    return parts[1] ?? null
}

function diffDays(expiration: string): number | null {
    const expirationAt = new Date(`${expiration}T00:00:00Z`)
    if (Number.isNaN(expirationAt.getTime())) {
        return null
    }

    const difference = expirationAt.getTime() - Date.now()
    return Math.round(difference / 86_400_000)
}

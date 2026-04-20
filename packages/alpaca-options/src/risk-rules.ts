import {
    alpacaOptionsPolicySchema,
    getIntentAction,
    type AccountState,
    type OrderIntent,
    type OrderLeg,
    type OrderLegSide,
    type Position,
    type RiskValidator,
} from "@valiq-trading/core"

export interface ParsedOptionContract {
    underlying: string
    expiration: string
    optionType: "call" | "put"
    strike: number
}

export type AlpacaStructureType = "iron_condor" | "credit_vertical"
export type AlpacaVerticalSpreadType = "bull_put_credit" | "bear_call_credit"

interface NormalizedOptionLeg extends ParsedOptionContract {
    instrument: string
    quantity: number
    side: OrderLegSide
    positionEffect: "open" | "close"
    exposure: "long" | "short"
}

interface ResolvedStructure {
    structureType: AlpacaStructureType
    verticalSpreadType?: AlpacaVerticalSpreadType
    underlying: string
    expiration: string
    spreadWidth: number
    legs: NormalizedOptionLeg[]
}

const SUPPORTED_ALPACA_ORDER_TYPE = "limit"
const SUPPORTED_ALPACA_TIME_IN_FORCE = "day"
const SUPPORTED_LEG_COUNTS = new Set([2, 4])

export const alpacaRiskValidators: readonly RiskValidator[] = [
    alpacaStructureValidator,
    maxLossPerPlayValidator,
    expiryValidationValidator,
    spreadWidthValidationValidator,
]

export function buildIronCondorInstrument(
    underlying: string,
    expiration: string,
    _quantity?: number
): string {
    return `IC:${underlying.toUpperCase()}:${expiration}`
}

export function buildCreditVerticalInstrument(
    underlying: string,
    expiration: string,
    verticalSpreadType: AlpacaVerticalSpreadType
): string {
    const type = verticalSpreadType === "bull_put_credit"
        ? "BULL_PUT_CREDIT"
        : "BEAR_CALL_CREDIT"
    return `VS:${type}:${underlying.toUpperCase()}:${expiration}`
}

export function buildIronCondorInstrumentFromLegs(
    underlying: string,
    expiration: string,
    legs: Array<{ instrument: string }>
): string {
    const normalizedLegs = legs
        .map((leg) => leg.instrument.trim().toUpperCase())
        .sort()
        .join("|")

    return `${buildIronCondorInstrument(underlying, expiration)}:${normalizedLegs}`
}

export function buildCreditVerticalInstrumentFromLegs(
    underlying: string,
    expiration: string,
    verticalSpreadType: AlpacaVerticalSpreadType,
    legs: Array<{ instrument: string }>
): string {
    const normalizedLegs = legs
        .map((leg) => leg.instrument.trim().toUpperCase())
        .sort()
        .join("|")

    return `${buildCreditVerticalInstrument(underlying, expiration, verticalSpreadType)}:${normalizedLegs}`
}

export function buildAlpacaStructureInstrumentFromLegs(structure: {
    structureType: AlpacaStructureType
    verticalSpreadType?: AlpacaVerticalSpreadType
    underlying: string
    expiration: string
    legs: Array<{ instrument: string }>
}): string {
    if (structure.structureType === "iron_condor") {
        return buildIronCondorInstrumentFromLegs(structure.underlying, structure.expiration, structure.legs)
    }

    if (!structure.verticalSpreadType) {
        throw new Error("Vertical Alpaca structure requires verticalSpreadType")
    }

    return buildCreditVerticalInstrumentFromLegs(
        structure.underlying,
        structure.expiration,
        structure.verticalSpreadType,
        structure.legs
    )
}

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

function alpacaStructureValidator(intent: OrderIntent) {
    const action = getIntentAction(intent)

    if (action === "adjustment") {
        return {
            allowed: false,
            reason: "Alpaca options adjustments are not supported for this strategy path. Use modify_order for working entries or propose_close for filled structures.",
        }
    }

    if (!intent.legs || intent.legs.length === 0) {
        return {
            allowed: false,
            reason: "Alpaca options orders must be submitted as either a 2-leg credit vertical or a 4-leg iron condor",
        }
    }

    if (!SUPPORTED_LEG_COUNTS.has(intent.legs.length)) {
        return {
            allowed: false,
            reason: "Alpaca options structures must contain exactly 2 or 4 legs",
        }
    }

    if (!Number.isInteger(intent.quantity) || intent.quantity <= 0) {
        return {
            allowed: false,
            reason: "Alpaca options structures require a positive integer structure quantity",
        }
    }

    if (intent.orderType !== SUPPORTED_ALPACA_ORDER_TYPE) {
        return {
            allowed: false,
            reason: "Alpaca options structures only support limit pricing",
        }
    }

    if (intent.timeInForce !== SUPPORTED_ALPACA_TIME_IN_FORCE) {
        return {
            allowed: false,
            reason: "Alpaca options structures only support day time in force",
        }
    }

    if (intent.stopPrice !== undefined) {
        return {
            allowed: false,
            reason: "Alpaca options structures do not support stop prices",
        }
    }

    if (intent.limitPrice === undefined || intent.limitPrice <= 0) {
        return {
            allowed: false,
            reason: "Alpaca options structures require a positive net credit/debit limit price",
        }
    }

    if (intent.legs.some((leg) => leg.limitPrice !== undefined)) {
        return {
            allowed: false,
            reason: "Per-leg limit prices are not supported for Alpaca options structures",
        }
    }

    const normalizedLegs = normalizeOptionLegs(intent)
    if (!Array.isArray(normalizedLegs)) {
        return normalizedLegs
    }

    const expirations = new Set(normalizedLegs.map((leg) => leg.expiration))
    if (expirations.size !== 1) {
        return {
            allowed: false,
            reason: "All legs in an Alpaca options structure must share the same expiration",
        }
    }

    const underlyings = new Set(normalizedLegs.map((leg) => leg.underlying))
    if (underlyings.size !== 1) {
        return {
            allowed: false,
            reason: "All legs in an Alpaca options structure must share the same underlying",
        }
    }

    const expectedEffect = action === "close" ? "close" : "open"
    if (normalizedLegs.some((leg) => leg.positionEffect !== expectedEffect)) {
        return {
            allowed: false,
            reason: action === "close"
                ? "Closing a structure requires buy_to_close/sell_to_close legs"
                : "Opening a structure requires buy_to_open/sell_to_open legs",
        }
    }

    if (!hasSupportedLegRatios(intent, normalizedLegs)) {
        return {
            allowed: false,
            reason: "Each Alpaca options structure leg must use a 1-lot ratio matching the top-level structure quantity",
        }
    }

    const resolvedStructure = resolveStructureFromNormalizedLegs(normalizedLegs)
    if (!resolvedStructure) {
        return {
            allowed: false,
            reason: normalizedLegs.length === 4
                ? "Leg strikes do not form a valid iron condor geometry"
                : "Leg strikes do not form a valid one-sided credit vertical",
        }
    }

    const structureLegs = resolvedStructure.legs
        .map((leg) => leg.instrument.trim().toUpperCase())
        .sort()

    return {
        allowed: true,
        adjustedIntent: {
            ...intent,
            instrument: buildAlpacaStructureInstrumentFromLegs({
                structureType: resolvedStructure.structureType,
                verticalSpreadType: resolvedStructure.verticalSpreadType,
                underlying: resolvedStructure.underlying,
                expiration: resolvedStructure.expiration,
                legs: resolvedStructure.legs,
            }),
            side: action === "close" ? "buy" : "sell",
            orderType: SUPPORTED_ALPACA_ORDER_TYPE,
            timeInForce: SUPPORTED_ALPACA_TIME_IN_FORCE,
            stopPrice: undefined,
            legs: resolvedStructure.legs.map<OrderLeg>((leg) => ({
                instrument: leg.instrument,
                side: leg.side,
                quantity: 1,
            })),
            metadata: {
                ...intent.metadata,
                action,
                structureType: resolvedStructure.structureType,
                verticalSpreadType: resolvedStructure.verticalSpreadType,
                underlying: resolvedStructure.underlying,
                expiration: resolvedStructure.expiration,
                expectedExpiration: resolvedStructure.expiration,
                spreadWidth: resolvedStructure.spreadWidth,
                structureLegs,
            },
        },
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
    const normalizedLegs = normalizeOptionLegs(intent)

    if (!Array.isArray(normalizedLegs) || normalizedLegs.length < 2) {
        const metadataWidth = intent.metadata?.spreadWidth
        return typeof metadataWidth === "number" ? metadataWidth : null
    }

    return calculateNormalizedStructureWidth(normalizedLegs)
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

function normalizeOptionLegs(intent: OrderIntent): NormalizedOptionLeg[] | { allowed: false; reason: string } {
    const action = getIntentAction(intent)
    const normalizedLegs: NormalizedOptionLeg[] = []

    for (const leg of intent.legs ?? []) {
        const parsed = parseOptionContractSymbol(leg.instrument)
        if (!parsed) {
            return {
                allowed: false,
                reason: `Invalid OCC option symbol: ${leg.instrument}`,
            }
        }

        const normalizedSide = normalizeLegSide(leg.side, action)
        if (!normalizedSide) {
            return {
                allowed: false,
                reason: `Unsupported Alpaca leg side ${leg.side} for ${action} orders`,
            }
        }

        normalizedLegs.push({
            ...parsed,
            instrument: leg.instrument,
            quantity: leg.quantity,
            side: normalizedSide,
            positionEffect: normalizedSide.endsWith("_close") ? "close" : "open",
            exposure: resolveExposureFromSide(normalizedSide),
        })
    }

    return normalizedLegs
}

function normalizeLegSide(
    side: OrderLegSide,
    action: ReturnType<typeof getIntentAction>
): OrderLegSide | null {
    if (
        side === "buy_to_open" ||
        side === "sell_to_open" ||
        side === "buy_to_close" ||
        side === "sell_to_close"
    ) {
        return side
    }

    if (side === "buy") {
        return action === "close" ? "buy_to_close" : "buy_to_open"
    }

    if (side === "sell") {
        return action === "close" ? "sell_to_close" : "sell_to_open"
    }

    return null
}

function resolveExposureFromSide(side: OrderLegSide): "long" | "short" {
    if (side === "sell_to_open" || side === "buy_to_close") {
        return "short"
    }
    return "long"
}

function hasSupportedLegRatios(intent: OrderIntent, legs: NormalizedOptionLeg[]): boolean {
    return legs.every((leg) => Number.isInteger(leg.quantity) && (leg.quantity === 1 || leg.quantity === intent.quantity))
}

function resolveStructureFromNormalizedLegs(legs: NormalizedOptionLeg[]): ResolvedStructure | null {
    if (legs.length === 4) {
        return resolveIronCondorStructure(legs)
    }

    if (legs.length === 2) {
        return resolveCreditVerticalStructure(legs)
    }

    return null
}

function resolveIronCondorStructure(legs: NormalizedOptionLeg[]): ResolvedStructure | null {
    const calls = legs.filter((leg) => leg.optionType === "call")
    const puts = legs.filter((leg) => leg.optionType === "put")
    const shorts = legs.filter((leg) => leg.exposure === "short")
    const longs = legs.filter((leg) => leg.exposure === "long")

    if (calls.length !== 2 || puts.length !== 2 || shorts.length !== 2 || longs.length !== 2) {
        return null
    }

    const shortCall = calls.find((leg) => leg.exposure === "short")
    const longCall = calls.find((leg) => leg.exposure === "long")
    const shortPut = puts.find((leg) => leg.exposure === "short")
    const longPut = puts.find((leg) => leg.exposure === "long")

    if (!shortCall || !longCall || !shortPut || !longPut) {
        return null
    }

    const validGeometry = (
        longPut.strike < shortPut.strike &&
        shortPut.strike < shortCall.strike &&
        shortCall.strike < longCall.strike
    )

    if (!validGeometry) {
        return null
    }

    const spreadWidth = calculateNormalizedStructureWidth(legs)
    if (spreadWidth === null) {
        return null
    }

    return {
        structureType: "iron_condor",
        underlying: legs[0]!.underlying,
        expiration: legs[0]!.expiration,
        spreadWidth,
        legs,
    }
}

function resolveCreditVerticalStructure(legs: NormalizedOptionLeg[]): ResolvedStructure | null {
    const shorts = legs.filter((leg) => leg.exposure === "short")
    const longs = legs.filter((leg) => leg.exposure === "long")

    if (shorts.length !== 1 || longs.length !== 1) {
        return null
    }

    const shortLeg = shorts[0]!
    const longLeg = longs[0]!
    if (shortLeg.optionType !== longLeg.optionType) {
        return null
    }

    let verticalSpreadType: AlpacaVerticalSpreadType | null = null
    let spreadWidth: number | null = null

    if (shortLeg.optionType === "call") {
        if (shortLeg.strike >= longLeg.strike) {
            return null
        }
        verticalSpreadType = "bear_call_credit"
        spreadWidth = longLeg.strike - shortLeg.strike
    } else {
        if (longLeg.strike >= shortLeg.strike) {
            return null
        }
        verticalSpreadType = "bull_put_credit"
        spreadWidth = shortLeg.strike - longLeg.strike
    }

    if (spreadWidth <= 0) {
        return null
    }

    return {
        structureType: "credit_vertical",
        verticalSpreadType,
        underlying: shortLeg.underlying,
        expiration: shortLeg.expiration,
        spreadWidth,
        legs: [shortLeg, longLeg],
    }
}

function calculateNormalizedStructureWidth(legs: NormalizedOptionLeg[]): number | null {
    const callStrikes = legs
        .filter((leg) => leg.optionType === "call")
        .map((leg) => leg.strike)
        .sort((left, right) => left - right)
    const putStrikes = legs
        .filter((leg) => leg.optionType === "put")
        .map((leg) => leg.strike)
        .sort((left, right) => left - right)

    const callWidth = callStrikes.length >= 2 ? callStrikes[callStrikes.length - 1]! - callStrikes[0]! : 0
    const putWidth = putStrikes.length >= 2 ? putStrikes[putStrikes.length - 1]! - putStrikes[0]! : 0
    const width = Math.max(callWidth, putWidth)

    return width > 0 ? width : null
}

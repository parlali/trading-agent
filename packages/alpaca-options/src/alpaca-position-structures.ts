import {
    createExecutionError,
    type OrderIntent,
    type Position,
} from "@valiq-trading/core"
import type { AlpacaPositionResponse } from "./alpaca-client"
import {
    buildAlpacaStructureInstrumentFromLegs,
    type AlpacaStructureType,
    type AlpacaVerticalSpreadType,
    parseOptionContractSymbol,
} from "./risk-rules"

export interface PositionGroup {
    structureType: AlpacaStructureType
    verticalSpreadType?: AlpacaVerticalSpreadType
    instrument: string
    underlying: string
    expiration: string
    quantity: number
    positions: AlpacaPositionResponse[]
    entryPrice: number
    currentPrice?: number
    unrealizedPnl?: number
}

export interface GroupingResult {
    groups: PositionGroup[]
    consumedQuantities: Map<string, number>
}

type ParsedOptionContract = NonNullable<ReturnType<typeof parseOptionContractSymbol>>

interface OptionPositionUnit {
    position: AlpacaPositionResponse
    parsed: ParsedOptionContract
}

interface OptionSpreadUnit {
    shortLeg: OptionPositionUnit
    longLeg: OptionPositionUnit
    optionType: "call" | "put"
}

interface IronCondorUnit {
    callSpread: OptionSpreadUnit
    putSpread: OptionSpreadUnit
}

interface CreditVerticalUnit {
    spread: OptionSpreadUnit
    verticalSpreadType: AlpacaVerticalSpreadType
}

export function buildGroupCloseIntent(group: PositionGroup): OrderIntent {
    const limitPrice = resolveGroupCloseLimitPrice(group)

    return {
        instrument: group.instrument,
        side: "buy",
        quantity: group.quantity,
        orderType: "limit",
        limitPrice,
        timeInForce: "day",
        legs: group.positions.map((position) => ({
            instrument: position.symbol,
            side: position.side === "long" ? "sell_to_close" : "buy_to_close",
            quantity: 1,
        })),
        metadata: {
            action: "close",
            structureType: group.structureType,
            verticalSpreadType: group.verticalSpreadType,
            underlying: group.underlying,
            expiration: group.expiration,
            entryPrice: group.entryPrice,
            positionSide: "short",
            structureLegs: group.positions
                .map((position) => position.symbol.trim().toUpperCase())
                .sort(),
        },
    }
}

function resolveGroupCloseLimitPrice(group: PositionGroup): number {
    if (group.currentPrice === undefined || group.currentPrice <= 0) {
        throw createExecutionError("pre_validation", `No current Alpaca option structure price found for ${group.instrument}`, {
            code: "POSITION_PRICE_UNAVAILABLE",
            retryable: false,
            details: {
                instrument: group.instrument,
                entryPrice: group.entryPrice,
            },
        })
    }

    return roundPrice(group.currentPrice)
}

export function isAlpacaOptionPosition(position: AlpacaPositionResponse): boolean {
    return position.asset_class === undefined || position.asset_class === "us_option"
}

export function toResidualPosition(
    position: AlpacaPositionResponse,
    consumedQuantities: Map<string, number>
): AlpacaPositionResponse | null {
    const consumed = consumedQuantities.get(position.symbol.toUpperCase()) ?? 0
    const total = parseOptionQuantity(position)
    const remaining = total - consumed

    if (remaining <= 0) {
        return null
    }

    const unrealizedTotal = toNumber(position.unrealized_pl)
    const scaledUnrealized = total > 0 && unrealizedTotal !== 0
        ? (unrealizedTotal / total) * remaining
        : undefined

    return {
        ...position,
        qty: String(remaining),
        unrealized_pl: scaledUnrealized !== undefined ? String(scaledUnrealized) : position.unrealized_pl,
    }
}

export function groupOptionStructures(positions: AlpacaPositionResponse[]): GroupingResult {
    const buckets = new Map<string, OptionPositionUnit[]>()

    for (const position of positions) {
        const parsed = parseOptionContractSymbol(position.symbol)
        if (!parsed) {
            continue
        }

        const quantity = parseOptionQuantity(position)
        if (quantity <= 0) {
            continue
        }

        const key = `${parsed.underlying}:${parsed.expiration}`
        const entry = buckets.get(key) ?? []
        for (let index = 0; index < quantity; index++) {
            entry.push({
                position,
                parsed,
            })
        }
        buckets.set(key, entry)
    }

    const groups: PositionGroup[] = []
    const consumedQuantities = new Map<string, number>()

    for (const units of buckets.values()) {
        const structures = buildStructureUnits(units)
        const aggregated = [
            ...aggregateCondorUnits(structures.condors),
            ...aggregateVerticalUnits(structures.verticals),
        ]

        for (const group of aggregated) {
            groups.push(group)
            for (const leg of group.positions) {
                const symbol = leg.symbol.toUpperCase()
                consumedQuantities.set(symbol, (consumedQuantities.get(symbol) ?? 0) + group.quantity)
            }
        }
    }

    return {
        groups,
        consumedQuantities,
    }
}

function buildStructureUnits(units: OptionPositionUnit[]): {
    condors: IronCondorUnit[]
    verticals: CreditVerticalUnit[]
} {
    const callShorts = units
        .filter((unit) => unit.parsed.optionType === "call" && unit.position.side === "short")
        .sort((left, right) => left.parsed.strike - right.parsed.strike)
    const callLongs = units
        .filter((unit) => unit.parsed.optionType === "call" && unit.position.side === "long")
        .sort((left, right) => left.parsed.strike - right.parsed.strike)
    const putShorts = units
        .filter((unit) => unit.parsed.optionType === "put" && unit.position.side === "short")
        .sort((left, right) => left.parsed.strike - right.parsed.strike)
    const putLongs = units
        .filter((unit) => unit.parsed.optionType === "put" && unit.position.side === "long")
        .sort((left, right) => left.parsed.strike - right.parsed.strike)

    const callSpreads = pairSpreads(callShorts, callLongs, Math.min(callShorts.length, callLongs.length), "call")
    const putSpreads = pairSpreads(putShorts, putLongs, Math.min(putShorts.length, putLongs.length), "put")
    const condorPairing = pairCondors(callSpreads, putSpreads)
    const verticals: CreditVerticalUnit[] = [
        ...condorPairing.remainingCallSpreads.map((spread) => ({
            spread,
            verticalSpreadType: "bear_call_credit" as const,
        })),
        ...condorPairing.remainingPutSpreads.map((spread) => ({
            spread,
            verticalSpreadType: "bull_put_credit" as const,
        })),
    ]

    return {
        condors: condorPairing.condors,
        verticals,
    }
}

function pairSpreads(
    shorts: OptionPositionUnit[],
    longs: OptionPositionUnit[],
    maxCount: number,
    optionType: "call" | "put"
): OptionSpreadUnit[] {
    const remainingShorts = [...shorts]
    const remainingLongs = [...longs]
    const spreads: OptionSpreadUnit[] = []

    while (spreads.length < maxCount && remainingShorts.length > 0 && remainingLongs.length > 0) {
        const shortLeg = remainingShorts.shift()
        if (!shortLeg) {
            break
        }

        const longIndex = selectLongLegIndex(shortLeg, remainingLongs, optionType)
        if (longIndex === null) {
            continue
        }
        const [longLeg] = remainingLongs.splice(longIndex, 1)
        if (!longLeg) {
            break
        }

        spreads.push({
            shortLeg,
            longLeg,
            optionType,
        })
    }

    return spreads
}

function selectLongLegIndex(
    shortLeg: OptionPositionUnit,
    longLegs: OptionPositionUnit[],
    optionType: "call" | "put"
): number | null {
    const preferredIndex = longLegs.findIndex((longLeg) => {
        return optionType === "call"
            ? longLeg.parsed.strike > shortLeg.parsed.strike
            : longLeg.parsed.strike < shortLeg.parsed.strike
    })

    return preferredIndex >= 0 ? preferredIndex : null
}

function pairCondors(
    callSpreads: OptionSpreadUnit[],
    putSpreads: OptionSpreadUnit[]
): {
    condors: IronCondorUnit[]
    remainingCallSpreads: OptionSpreadUnit[]
    remainingPutSpreads: OptionSpreadUnit[]
} {
    const remainingCalls = [...callSpreads]
    const remainingPuts = [...putSpreads]
    const unmatchedCalls: OptionSpreadUnit[] = []
    const condors: IronCondorUnit[] = []

    while (remainingCalls.length > 0 && remainingPuts.length > 0) {
        const callSpread = remainingCalls.shift()
        if (!callSpread) {
            continue
        }
        const putIndex = selectPutSpreadIndex(callSpread, remainingPuts)
        if (putIndex === null) {
            unmatchedCalls.push(callSpread)
            continue
        }
        const [putSpread] = remainingPuts.splice(putIndex, 1)
        if (!putSpread) {
            continue
        }

        condors.push({
            callSpread,
            putSpread,
        })
    }

    return {
        condors,
        remainingCallSpreads: [...unmatchedCalls, ...remainingCalls],
        remainingPutSpreads: remainingPuts,
    }
}

function selectPutSpreadIndex(
    callSpread: OptionSpreadUnit,
    putSpreads: OptionSpreadUnit[]
): number | null {
    let closestIndex: number | null = null
    let closestDistance = Number.POSITIVE_INFINITY

    for (let index = 0; index < putSpreads.length; index++) {
        const candidate = putSpreads[index]
        if (!candidate) {
            continue
        }
        if (candidate.shortLeg.parsed.strike >= callSpread.shortLeg.parsed.strike) {
            continue
        }

        const distance = Math.abs(callSpread.shortLeg.parsed.strike - candidate.shortLeg.parsed.strike)
        if (distance < closestDistance) {
            closestDistance = distance
            closestIndex = index
        }
    }

    return closestIndex
}

function aggregateCondorUnits(units: IronCondorUnit[]): PositionGroup[] {
    const groupsByKey = new Map<string, IronCondorUnit[]>()

    for (const unit of units) {
        const key = buildCondorUnitKey(unit)
        const entry = groupsByKey.get(key) ?? []
        entry.push(unit)
        groupsByKey.set(key, entry)
    }

    return Array.from(groupsByKey.values())
        .map((groupUnits) => buildPositionGroupFromCondorUnits(groupUnits))
        .filter((group): group is PositionGroup => Boolean(group))
}

function aggregateVerticalUnits(units: CreditVerticalUnit[]): PositionGroup[] {
    const groupsByKey = new Map<string, CreditVerticalUnit[]>()

    for (const unit of units) {
        const key = buildVerticalUnitKey(unit)
        const entry = groupsByKey.get(key) ?? []
        entry.push(unit)
        groupsByKey.set(key, entry)
    }

    return Array.from(groupsByKey.values())
        .map((groupUnits) => buildPositionGroupFromVerticalUnits(groupUnits))
        .filter((group): group is PositionGroup => Boolean(group))
}

function buildCondorUnitKey(unit: IronCondorUnit): string {
    const legs = [
        unit.callSpread.shortLeg.position.symbol,
        unit.callSpread.longLeg.position.symbol,
        unit.putSpread.shortLeg.position.symbol,
        unit.putSpread.longLeg.position.symbol,
    ]
        .map((symbol) => symbol.trim().toUpperCase())
        .sort()
        .join("|")

    return `${unit.callSpread.shortLeg.parsed.underlying}:${unit.callSpread.shortLeg.parsed.expiration}:${legs}`
}

function buildVerticalUnitKey(unit: CreditVerticalUnit): string {
    const legs = [
        unit.spread.shortLeg.position.symbol,
        unit.spread.longLeg.position.symbol,
    ]
        .map((symbol) => symbol.trim().toUpperCase())
        .sort()
        .join("|")

    return `${unit.verticalSpreadType}:${unit.spread.shortLeg.parsed.underlying}:${unit.spread.shortLeg.parsed.expiration}:${legs}`
}

function buildPositionGroupFromCondorUnits(units: IronCondorUnit[]): PositionGroup | null {
    const first = units[0]
    if (!first) {
        return null
    }

    const positions = [
        first.callSpread.shortLeg.position,
        first.callSpread.longLeg.position,
        first.putSpread.shortLeg.position,
        first.putSpread.longLeg.position,
    ]
    const underlying = first.callSpread.shortLeg.parsed.underlying
    const expiration = first.callSpread.shortLeg.parsed.expiration
    const quantity = units.length
    const unrealizedPnl = units.reduce((sum, unit) => {
        const unitLegs = [
            unit.callSpread.shortLeg.position,
            unit.callSpread.longLeg.position,
            unit.putSpread.shortLeg.position,
            unit.putSpread.longLeg.position,
        ]
        return sum + sumUnitUnrealizedPnl(unitLegs)
    }, 0)

    return buildPositionGroup({
        structureType: "iron_condor",
        underlying,
        expiration,
        quantity,
        positions,
        unrealizedPnl,
    })
}

function buildPositionGroupFromVerticalUnits(units: CreditVerticalUnit[]): PositionGroup | null {
    const first = units[0]
    if (!first) {
        return null
    }

    const positions = [
        first.spread.shortLeg.position,
        first.spread.longLeg.position,
    ]
    const underlying = first.spread.shortLeg.parsed.underlying
    const expiration = first.spread.shortLeg.parsed.expiration
    const quantity = units.length
    const verticalSpreadType = first.verticalSpreadType
    const unrealizedPnl = units.reduce((sum, unit) => {
        const unitLegs = [
            unit.spread.shortLeg.position,
            unit.spread.longLeg.position,
        ]
        return sum + sumUnitUnrealizedPnl(unitLegs)
    }, 0)

    return buildPositionGroup({
        structureType: "credit_vertical",
        verticalSpreadType,
        underlying,
        expiration,
        quantity,
        positions,
        unrealizedPnl,
    })
}

function buildPositionGroup(args: {
    structureType: AlpacaStructureType
    verticalSpreadType?: AlpacaVerticalSpreadType
    underlying: string
    expiration: string
    quantity: number
    positions: AlpacaPositionResponse[]
    unrealizedPnl: number
}): PositionGroup {
    const entryPrice = Math.abs(sumNetStructurePrice(args.positions, (position) => toNumber(position.avg_entry_price)))
    const currentPrice = args.positions.every((position) => toNumber(position.current_price) > 0)
        ? Math.abs(sumNetStructurePrice(args.positions, (position) => toNumber(position.current_price)))
        : undefined

    return {
        structureType: args.structureType,
        verticalSpreadType: args.verticalSpreadType,
        instrument: buildAlpacaStructureInstrumentFromLegs({
            structureType: args.structureType,
            verticalSpreadType: args.verticalSpreadType,
            underlying: args.underlying,
            expiration: args.expiration,
            legs: args.positions.map((position) => ({
                instrument: position.symbol,
            })),
        }),
        underlying: args.underlying,
        expiration: args.expiration,
        quantity: args.quantity,
        positions: args.positions,
        entryPrice: roundPrice(entryPrice),
        currentPrice: currentPrice !== undefined ? roundPrice(currentPrice) : undefined,
        unrealizedPnl: roundPrice(args.unrealizedPnl),
    }
}

function sumUnitUnrealizedPnl(legs: AlpacaPositionResponse[]): number {
    return legs.reduce((legSum, leg) => {
        const totalQuantity = parseOptionQuantity(leg)
        if (totalQuantity <= 0) {
            return legSum
        }
        return legSum + (toNumber(leg.unrealized_pl) / totalQuantity)
    }, 0)
}

function sumNetStructurePrice(
    positions: AlpacaPositionResponse[],
    resolvePrice: (position: AlpacaPositionResponse) => number
): number {
    return positions.reduce((sum, position) => {
        const side = position.side.toLowerCase()
        const multiplier = side === "short" ? -1 : 1
        return sum + resolvePrice(position) * multiplier
    }, 0)
}

export function mapGroupedPosition(group: PositionGroup): Position {
    return {
        instrument: group.instrument,
        side: "short",
        quantity: group.quantity,
        entryPrice: group.entryPrice,
        currentPrice: group.currentPrice,
        unrealizedPnl: group.unrealizedPnl,
        metadata: {
            structureType: group.structureType,
            verticalSpreadType: group.verticalSpreadType,
            underlying: group.underlying,
            expiration: group.expiration,
            structureLegs: group.positions
                .map((position) => position.symbol.trim().toUpperCase())
                .sort(),
            legs: group.positions.map((position) => ({
                symbol: position.symbol,
                side: position.side,
                qty: Math.abs(toNumber(position.qty)),
            })),
        },
    }
}

export function mapSinglePosition(position: AlpacaPositionResponse): Position {
    const parsed = parseOptionContractSymbol(position.symbol)
    return {
        instrument: position.symbol,
        side: position.side,
        quantity: Math.abs(toNumber(position.qty)),
        entryPrice: toNumber(position.avg_entry_price),
        currentPrice: position.current_price ? toNumber(position.current_price) : undefined,
        unrealizedPnl: position.unrealized_pl ? toNumber(position.unrealized_pl) : undefined,
        metadata: parsed
            ? {
                underlying: parsed.underlying,
                expiration: parsed.expiration,
                optionType: parsed.optionType,
                strike: parsed.strike,
            }
            : undefined,
    }
}

export function resolveGroupForClose(
    positions: AlpacaPositionResponse[],
    instrument: string
): PositionGroup | null {
    const grouped = groupOptionStructures(positions.filter(isAlpacaOptionPosition)).groups
    const normalizedInstrument = instrument.trim().toUpperCase()
    const directMatch = grouped.find((group) => group.instrument.trim().toUpperCase() === normalizedInstrument)
    if (directMatch) {
        return directMatch
    }

    const byUnderlying = grouped.filter((group) => group.underlying === normalizedInstrument)
    if (byUnderlying.length === 1) {
        return byUnderlying[0] ?? null
    }

    const bySymbol = grouped.filter((group) => {
        return group.positions.some((position) => position.symbol.trim().toUpperCase() === normalizedInstrument)
    })
    if (bySymbol.length === 1) {
        return bySymbol[0] ?? null
    }

    return null
}

export function toNumber(value: string | undefined): number {
    return value ? Number(value) : 0
}

function parseOptionQuantity(position: AlpacaPositionResponse): number {
    const quantity = Math.abs(toNumber(position.qty))
    if (!Number.isFinite(quantity)) {
        return 0
    }

    const roundedQuantity = Math.round(quantity)
    if (Math.abs(quantity - roundedQuantity) > 1e-9) {
        return 0
    }

    return roundedQuantity
}

export function roundPrice(price: number): number {
    return Math.round(price * 100) / 100
}

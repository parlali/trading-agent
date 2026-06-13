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

interface PositionLike {
    instrument: string
    providerPositionId?: string
    side: "long" | "short"
    quantity: number
    entryPrice: number
    currentPrice?: number
    unrealizedPnl?: number
    metadata?: Record<string, unknown>
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

export function resolveAlpacaCloseGroupsFromPositions<TPosition extends PositionLike>(
    positions: TPosition[]
): TPosition[] {
    if (positions.length === 0) {
        return []
    }

    const grouped: TPosition[] = []
    const consumed = new Set<number>()
    const claimGroups = groupPositionsByClaimInstrument(positions)

    for (const group of claimGroups.values()) {
        const first = group.entries[0]
        if (!first) {
            continue
        }

        for (const index of group.indexes) {
            consumed.add(index)
        }

        const claim = parseClaimedStructureInstrument(group.claimInstrument)
        if (!claim) {
            continue
        }

        if (group.entries.length === 1 && first.instrument.trim().toUpperCase() === group.claimInstrument) {
            grouped.push(first)
        } else if (isCompleteClaimCloseGroup(claim, group.entries)) {
            grouped.push(buildSyntheticClosePosition(first, group.claimInstrument, group.entries) as TPosition)
        } else {
            for (const index of group.indexes) {
                consumed.delete(index)
            }
        }
    }

    positions.forEach((position, index) => {
        if (!consumed.has(index)) {
            grouped.push(position)
        }
    })

    return grouped
}

export function resolveAlpacaForceResetCloseGroupsFromPositions<TPosition extends PositionLike>(
    positions: TPosition[]
): TPosition[] {
    const claimGrouped = resolveAlpacaCloseGroupsFromPositions(positions)
    const structured = claimGrouped.filter((position) => !isAlpacaRawOptionLegPosition(position))
    const rawLegs = claimGrouped.filter((position) => isAlpacaRawOptionLegPosition(position))
    const emergencyGrouped = groupEmergencyAlpacaClosePositions(rawLegs)
    return [...structured, ...emergencyGrouped]
}

function groupEmergencyAlpacaClosePositions<TPosition extends PositionLike>(
    positions: TPosition[]
): TPosition[] {
    if (positions.length === 0) {
        return []
    }

    const buckets = new Map<string, TPosition[]>()
    for (const position of positions) {
        const parsed = parseOptionContractSymbol(position.instrument)
        if (!parsed) {
            buckets.set(position.instrument, [position])
            continue
        }

        const bucketKey = `${parsed.underlying}:${parsed.expiration}`
        const bucket = buckets.get(bucketKey) ?? []
        bucket.push(position)
        buckets.set(bucketKey, bucket)
    }

    const grouped: TPosition[] = []
    for (const bucket of buckets.values()) {
        let unused = [...bucket]

        if (unused.length === 4) {
            const structure = resolveStructureFromProviderPositions(unused)
            if (structure?.structureType === "iron_condor") {
                grouped.push(buildEmergencySyntheticClosePosition(unused, structure) as TPosition)
                unused = []
            }
        }

        while (unused.length >= 2) {
            const vertical = findProviderStructureSubset(unused, 2)
            if (!vertical) {
                break
            }

            const structure = resolveStructureFromProviderPositions(vertical)
            if (!structure || structure.structureType !== "credit_vertical") {
                break
            }

            grouped.push(buildEmergencySyntheticClosePosition(vertical, structure) as TPosition)
            unused = removeProviderPositions(unused, vertical)
        }

        grouped.push(...unused)
    }

    return grouped
}

function findProviderStructureSubset<TPosition extends PositionLike>(
    positions: TPosition[],
    size: number
): TPosition[] | null {
    if (positions.length < size) {
        return null
    }

    if (positions.length === size) {
        return resolveStructureFromProviderPositions(positions) ? positions : null
    }

    const indexes = Array.from({ length: positions.length }, (_, index) => index)
    const combinations = buildIndexCombinations(indexes, size)
    for (const combination of combinations) {
        const subset = combination.map((index) => positions[index]!)
        if (resolveStructureFromProviderPositions(subset)) {
            return subset
        }
    }

    return null
}

function buildIndexCombinations(indexes: number[], size: number): number[][] {
    if (size === 0) {
        return [[]]
    }

    if (indexes.length < size) {
        return []
    }

    if (size === 1) {
        return indexes.map((index) => [index])
    }

    const combinations: number[][] = []
    for (let index = 0; index <= indexes.length - size; index++) {
        const head = indexes[index]!
        const tailCombinations = buildIndexCombinations(indexes.slice(index + 1), size - 1)
        for (const tail of tailCombinations) {
            combinations.push([head, ...tail])
        }
    }

    return combinations
}

function removeProviderPositions<TPosition extends PositionLike>(
    positions: TPosition[],
    remove: TPosition[]
): TPosition[] {
    const removeSet = new Set(remove)
    return positions.filter((position) => !removeSet.has(position))
}

function resolveStructureFromProviderPositions<TPosition extends PositionLike>(
    positions: TPosition[]
): {
    structureType: AlpacaStructureType
    verticalSpreadType?: AlpacaVerticalSpreadType
    underlying: string
    expiration: string
    legs: Array<{ instrument: string }>
} | null {
    if (positions.length !== 2 && positions.length !== 4) {
        return null
    }

    const normalized = positions
        .map((position) => {
            const parsed = parseOptionContractSymbol(position.instrument)
            if (!parsed) {
                return null
            }

            return {
                symbol: position.instrument.trim().toUpperCase(),
                parsed,
                exposure: position.side,
            }
        })
        .filter((entry): entry is {
            symbol: string
            parsed: NonNullable<ReturnType<typeof parseOptionContractSymbol>>
            exposure: "long" | "short"
        } => Boolean(entry))

    if (normalized.length !== positions.length) {
        return null
    }

    const underlying = normalized[0]?.parsed.underlying
    const expiration = normalized[0]?.parsed.expiration
    const sharedContract = normalized.every((leg) =>
        leg.parsed.underlying === underlying && leg.parsed.expiration === expiration
    )
    if (!underlying || !expiration || !sharedContract) {
        return null
    }

    if (normalized.length === 4) {
        const calls = normalized.filter((leg) => leg.parsed.optionType === "call")
        const puts = normalized.filter((leg) => leg.parsed.optionType === "put")
        if (calls.length !== 2 || puts.length !== 2) {
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
            longPut.parsed.strike < shortPut.parsed.strike &&
            shortPut.parsed.strike < shortCall.parsed.strike &&
            shortCall.parsed.strike < longCall.parsed.strike
        )
        if (!validGeometry) {
            return null
        }

        return {
            structureType: "iron_condor",
            underlying,
            expiration,
            legs: normalized.map((leg) => ({
                instrument: leg.symbol,
            })),
        }
    }

    const shorts = normalized.filter((leg) => leg.exposure === "short")
    const longs = normalized.filter((leg) => leg.exposure === "long")
    if (shorts.length !== 1 || longs.length !== 1) {
        return null
    }

    const shortLeg = shorts[0]!
    const longLeg = longs[0]!
    if (shortLeg.parsed.optionType !== longLeg.parsed.optionType) {
        return null
    }

    if (shortLeg.parsed.optionType === "call") {
        if (shortLeg.parsed.strike >= longLeg.parsed.strike) {
            return null
        }

        return {
            structureType: "credit_vertical",
            verticalSpreadType: "bear_call_credit",
            underlying,
            expiration,
            legs: normalized.map((leg) => ({
                instrument: leg.symbol,
            })),
        }
    }

    if (longLeg.parsed.strike >= shortLeg.parsed.strike) {
        return null
    }

    return {
        structureType: "credit_vertical",
        verticalSpreadType: "bull_put_credit",
        underlying,
        expiration,
        legs: normalized.map((leg) => ({
            instrument: leg.symbol,
        })),
    }
}

function buildEmergencySyntheticClosePosition<TPosition extends PositionLike>(
    entries: TPosition[],
    structure: {
        structureType: AlpacaStructureType
        verticalSpreadType?: AlpacaVerticalSpreadType
        underlying: string
        expiration: string
        legs: Array<{ instrument: string }>
    }
): TPosition {
    const instrument = buildAlpacaStructureInstrumentFromLegs(structure)
    const first = entries[0]!
    return buildSyntheticClosePosition(first, instrument, entries, {
        alpacaEmergencyCloseGroup: true,
    }) as TPosition
}

function groupPositionsByClaimInstrument<TPosition extends PositionLike>(
    positions: TPosition[]
): Map<string, { claimInstrument: string; entries: TPosition[]; indexes: number[] }> {
    const groups = new Map<string, { claimInstrument: string; entries: TPosition[]; indexes: number[] }>()

    positions.forEach((position, index) => {
        const claimInstrument = readClaimInstrument(position)
        if (!claimInstrument || !parseClaimedStructureInstrument(claimInstrument)) {
            return
        }

        const group = groups.get(claimInstrument) ?? {
            claimInstrument,
            entries: [],
            indexes: [],
        }
        group.entries.push(position)
        group.indexes.push(index)
        groups.set(claimInstrument, group)
    })

    return groups
}

function isCreditVerticalLongLeg(
    shortLeg: NonNullable<ReturnType<typeof parseOptionContractSymbol>>,
    longLeg: NonNullable<ReturnType<typeof parseOptionContractSymbol>>
): boolean {
    return shortLeg.optionType === "call"
        ? longLeg.strike > shortLeg.strike
        : longLeg.strike < shortLeg.strike
}

type ClaimedStructureInstrument = NonNullable<ReturnType<typeof parseClaimedStructureInstrument>>

function isCompleteClaimCloseGroup<TPosition extends PositionLike>(
    claim: ClaimedStructureInstrument,
    entries: TPosition[]
): boolean {
    if (entries.length !== claim.legs.length) {
        return false
    }

    const claimedLegs = new Set(claim.legs)
    const entriesByInstrument = new Map(entries.map((entry) => [entry.instrument.trim().toUpperCase(), entry]))
    if (entriesByInstrument.size !== entries.length) {
        return false
    }

    for (const leg of claimedLegs) {
        if (!entriesByInstrument.has(leg)) {
            return false
        }
    }

    if (entries.some((entry) => !claimedLegs.has(entry.instrument.trim().toUpperCase()))) {
        return false
    }

    const quantities = new Set(entries.map((entry) => entry.quantity))
    const quantity = entries[0]?.quantity
    if (quantities.size !== 1 || quantity === undefined || quantity <= 0 || !Number.isFinite(quantity)) {
        return false
    }

    if (claim.structureType === "credit_vertical") {
        return isCompleteVerticalClaimCloseGroup(claim, entries)
    }

    return isCompleteIronCondorClaimCloseGroup(claim, entries)
}

function isCompleteVerticalClaimCloseGroup<TPosition extends PositionLike>(
    claim: ClaimedStructureInstrument,
    entries: TPosition[]
): boolean {
    if (!claim.verticalSpreadType || entries.length !== 2) {
        return false
    }

    const parsedEntries = readParsedClaimEntries(claim, entries)
    if (!parsedEntries) {
        return false
    }

    const shortEntry = parsedEntries.find((entry) => entry.position.side === "short")
    const longEntry = parsedEntries.find((entry) => entry.position.side === "long")
    if (!shortEntry || !longEntry) {
        return false
    }

    const expectedOptionType = claim.verticalSpreadType === "bear_call_credit" ? "call" : "put"
    return shortEntry.parsed.optionType === expectedOptionType &&
        longEntry.parsed.optionType === expectedOptionType &&
        isCreditVerticalLongLeg(shortEntry.parsed, longEntry.parsed)
}

function isCompleteIronCondorClaimCloseGroup<TPosition extends PositionLike>(
    claim: ClaimedStructureInstrument,
    entries: TPosition[]
): boolean {
    if (entries.length !== 4) {
        return false
    }

    const parsedEntries = readParsedClaimEntries(claim, entries)
    if (!parsedEntries) {
        return false
    }

    const calls = parsedEntries.filter((entry) => entry.parsed.optionType === "call")
    const puts = parsedEntries.filter((entry) => entry.parsed.optionType === "put")
    return isCompleteIronCondorSide(calls) && isCompleteIronCondorSide(puts)
}

function isCompleteIronCondorSide<TPosition extends PositionLike>(
    entries: Array<{ position: TPosition; parsed: NonNullable<ReturnType<typeof parseOptionContractSymbol>> }>
): boolean {
    if (entries.length !== 2) {
        return false
    }

    const shortEntry = entries.find((entry) => entry.position.side === "short")
    const longEntry = entries.find((entry) => entry.position.side === "long")
    if (!shortEntry || !longEntry) {
        return false
    }

    return isCreditVerticalLongLeg(shortEntry.parsed, longEntry.parsed)
}

function readParsedClaimEntries<TPosition extends PositionLike>(
    claim: ClaimedStructureInstrument,
    entries: TPosition[]
): Array<{ position: TPosition; parsed: NonNullable<ReturnType<typeof parseOptionContractSymbol>> }> | null {
    const parsedEntries = entries.map((position) => ({
        position,
        parsed: parseOptionContractSymbol(position.instrument),
    }))

    if (parsedEntries.some((entry) => !entry.parsed)) {
        return null
    }

    const normalized = parsedEntries as Array<{
        position: TPosition
        parsed: NonNullable<ReturnType<typeof parseOptionContractSymbol>>
    }>
    return normalized.every((entry) =>
        entry.parsed.underlying === claim.underlying &&
        entry.parsed.expiration === claim.expiration
    )
        ? normalized
        : null
}

export function isAlpacaRawOptionLegPosition(position: PositionLike): boolean {
    return !position.instrument.includes(":") && Boolean(parseOptionContractSymbol(position.instrument))
}

function buildSyntheticClosePosition<TPosition extends PositionLike>(
    first: TPosition,
    instrument: string,
    entries: TPosition[],
    metadata: Record<string, unknown> = {}
): Position {
    const quantity = Math.min(...entries.map((entry) => entry.quantity))
    const entryPrice = Math.abs(sumPositionPrices(entries, "entryPrice"))
    const currentPrice = entries.every((entry) => entry.currentPrice !== undefined)
        ? Math.abs(sumPositionPrices(entries, "currentPrice"))
        : undefined
    const unrealizedPnl = entries.some((entry) => entry.unrealizedPnl !== undefined)
        ? entries.reduce((sum, entry) => sum + (entry.unrealizedPnl ?? 0), 0)
        : undefined

    return {
        instrument,
        providerPositionId: readClaimPositionId(first) ?? first.providerPositionId,
        side: "short",
        quantity,
        entryPrice: roundPrice(entryPrice),
        currentPrice: currentPrice !== undefined ? roundPrice(currentPrice) : undefined,
        unrealizedPnl: unrealizedPnl !== undefined ? roundPrice(unrealizedPnl) : undefined,
        metadata: {
            ...first.metadata,
            ...metadata,
            alpacaClaimInstrument: instrument,
            alpacaCloseGroup: true,
            providerLegs: entries.map((entry) => ({
                instrument: entry.instrument,
                providerPositionId: entry.providerPositionId,
                side: entry.side,
                quantity: entry.quantity,
                entryPrice: entry.entryPrice,
                currentPrice: entry.currentPrice,
                positionKey: readMetadataString(entry.metadata, "positionKey"),
            })),
        },
    }
}

function sumPositionPrices<TPosition extends PositionLike>(
    positions: TPosition[],
    key: "entryPrice" | "currentPrice"
): number {
    return positions.reduce((sum, position) => {
        const value = position[key] ?? 0
        const multiplier = position.side === "short" ? -1 : 1
        return sum + value * multiplier
    }, 0)
}

function readClaimInstrument(position: PositionLike): string | undefined {
    return readMetadataString(position.metadata, "alpacaClaimInstrument") ??
        readMetadataString(position.metadata, "claimInstrument") ??
        (
            parseClaimedStructureInstrument(position.instrument)
                ? position.instrument.trim().toUpperCase()
                : undefined
        )
}

function readClaimPositionId(position: PositionLike): string | undefined {
    return readMetadataString(position.metadata, "alpacaClaimPositionId") ??
        readMetadataString(position.metadata, "claimId")
}

function readMetadataString(
    metadata: Record<string, unknown> | undefined,
    key: string
): string | undefined {
    const value = metadata?.[key]
    return typeof value === "string" && value.trim()
        ? value.trim()
        : undefined
}

export function isAlpacaOptionPosition(position: AlpacaPositionResponse): boolean {
    return position.asset_class === undefined || position.asset_class === "us_option"
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

export function mapSinglePosition(position: AlpacaPositionResponse): Position {
    const parsed = parseOptionContractSymbol(position.symbol)
    return {
        instrument: position.symbol,
        providerPositionId: position.symbol,
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
                providerPositionId: position.symbol,
            }
            : undefined,
    }
}

export function resolveGroupForClose(
    positions: AlpacaPositionResponse[],
    instrument: string
): PositionGroup | null {
    const claim = parseClaimedStructureInstrument(instrument)
    if (!claim) {
        return null
    }

    const positionsBySymbol = new Map(
        positions
            .filter(isAlpacaOptionPosition)
            .map((position) => [position.symbol.trim().toUpperCase(), position])
    )
    const claimedPositions = claim.legs
        .map((leg) => positionsBySymbol.get(leg))
        .filter((position): position is AlpacaPositionResponse => Boolean(position))

    if (claimedPositions.length !== claim.legs.length) {
        return null
    }

    const claimedEntries = claimedPositions.map(toClaimPositionLike)
    if (!isCompleteClaimCloseGroup(claim, claimedEntries)) {
        return null
    }

    const quantity = claimedEntries[0]?.quantity ?? 0
    if (!Number.isFinite(quantity) || quantity <= 0) {
        return null
    }

    const scaledPositions = claimedPositions.map((position) => ({
        ...position,
        qty: String(quantity),
    }))
    const unrealizedPnl = scaledPositions.reduce((sum, position) => sum + toNumber(position.unrealized_pl), 0)

    return buildPositionGroup({
        structureType: claim.structureType,
        verticalSpreadType: claim.verticalSpreadType,
        underlying: claim.underlying,
        expiration: claim.expiration,
        quantity,
        positions: scaledPositions,
        unrealizedPnl,
    })
}

function toClaimPositionLike(position: AlpacaPositionResponse): PositionLike {
    return {
        instrument: position.symbol,
        side: position.side,
        quantity: parseOptionQuantity(position),
        entryPrice: toNumber(position.avg_entry_price),
        currentPrice: position.current_price ? toNumber(position.current_price) : undefined,
        unrealizedPnl: position.unrealized_pl ? toNumber(position.unrealized_pl) : undefined,
    }
}

function parseClaimedStructureInstrument(instrument: string): {
    structureType: AlpacaStructureType
    verticalSpreadType?: AlpacaVerticalSpreadType
    underlying: string
    expiration: string
    legs: string[]
} | null {
    const [kind, first, second, third, legList] = instrument.trim().toUpperCase().split(":")

    if (kind === "IC" && first && second && third) {
        const legs = third.split("|").map((leg) => leg.trim()).filter(Boolean)
        return legs.length === 4
            ? {
                structureType: "iron_condor",
                underlying: first,
                expiration: second,
                legs,
            }
            : null
    }

    if (kind !== "VS" || !first || !second || !third || !legList) {
        return null
    }

    const verticalSpreadType = first === "BULL_PUT_CREDIT"
        ? "bull_put_credit"
        : first === "BEAR_CALL_CREDIT"
            ? "bear_call_credit"
            : undefined
    if (!verticalSpreadType) {
        return null
    }

    const legs = legList.split("|").map((leg) => leg.trim()).filter(Boolean)
    return legs.length === 2
        ? {
            structureType: "credit_vertical",
            verticalSpreadType,
            underlying: second,
            expiration: third,
            legs,
        }
        : null
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

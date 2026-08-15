import {
    createExecutionError,
    type OrderIntent,
    type Position,
} from "@valiq-trading/core"
import type { AlpacaPositionResponse } from "./alpaca-client"
import {
    buildAlpacaStructureInstrumentFromLegs,
    deriveAlpacaOptionLegStructures,
    parseClaimedStructureInstrument,
    type AlpacaStructureType,
    type AlpacaVerticalSpreadType,
    parseOptionContractSymbol,
    type ResolvedStructure,
} from "./risk-rules"

export { parseClaimedStructureInstrument }

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

export interface PositionLike {
    instrument: string
    providerPositionId?: string
    side: "long" | "short"
    quantity: number
    entryPrice: number
    currentPrice?: number
    unrealizedPnl?: number
    metadata?: Record<string, unknown>
}

export interface ClaimedStructureSingleLegOwnershipTarget {
    claimInstrument: string
    legInstruments: string[]
}

export interface ResolveClaimedStructureSingleLegOwnershipArgs<TPosition extends PositionLike> {
    instrument: string
    positions: readonly TPosition[]
    claimInstruments: ReadonlySet<string> | readonly string[]
    requestedPosition?: TPosition
    onAmbiguous?: (legSymbol: string, claimInstruments: string[]) => never
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

export function resolveClaimedStructureSingleLegOwnership<TPosition extends PositionLike>(
    args: ResolveClaimedStructureSingleLegOwnershipArgs<TPosition>
): ClaimedStructureSingleLegOwnershipTarget | null {
    const legSymbol = args.instrument.trim().toUpperCase()
    if (!parseOptionContractSymbol(legSymbol)) {
        return null
    }

    const matchingClaims = readMatchingClaimInstruments(legSymbol, args.claimInstruments)
    if (matchingClaims.length === 0) {
        return null
    }

    const requestedPosition = args.requestedPosition ?? args.positions.find((position) =>
        position.instrument.trim().toUpperCase() === legSymbol
    )
    if (matchingClaims.length > 1 && requestedPosition?.side === "short") {
        throwSingleLegAmbiguousStructureClaim(args, legSymbol, matchingClaims.map((match) => match.claimInstrument))
    }

    const exactMatches = matchingClaims
        .map((match) => resolveExactSingleLegOwnershipMatch(args.positions, match, requestedPosition?.quantity))
        .filter((match): match is ClaimedStructureSingleLegOwnershipTarget => Boolean(match))

    if (exactMatches.length === 1) {
        return exactMatches[0]!
    }

    if (exactMatches.length > 1) {
        throwSingleLegAmbiguousStructureClaim(args, legSymbol, exactMatches.map((match) => match.claimInstrument))
    }

    const viableMatches = matchingClaims
        .map((match) => resolveMinimumSingleLegOwnershipMatch(args.positions, match))
        .filter((match): match is ClaimedStructureSingleLegOwnershipTarget => Boolean(match))

    if (viableMatches.length === 1) {
        return viableMatches[0]!
    }

    if (viableMatches.length > 1) {
        throwSingleLegAmbiguousStructureClaim(args, legSymbol, viableMatches.map((match) => match.claimInstrument))
    }

    return null
}

export function hasClaimedStructureSingleLegOwnershipCandidate(
    instrument: string,
    claimInstruments: ReadonlySet<string> | readonly string[]
): boolean {
    const legSymbol = instrument.trim().toUpperCase()
    return Boolean(parseOptionContractSymbol(legSymbol)) &&
        readMatchingClaimInstruments(legSymbol, claimInstruments).length > 0
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

    const derived = deriveAlpacaOptionLegStructures(positions)
    return [
        ...derived.groups.map((group) =>
            buildEmergencySyntheticClosePosition(group.positions, group.structure) as TPosition
        ),
        ...derived.ungrouped,
    ]
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
type ClaimedStructureMatch = {
    claimInstrument: string
    claim: ClaimedStructureInstrument
}

function readMatchingClaimInstruments(
    legSymbol: string,
    claimInstruments: ReadonlySet<string> | readonly string[]
): ClaimedStructureMatch[] {
    return Array.from(claimInstruments)
        .map((claimInstrument) => {
            const normalizedClaimInstrument = claimInstrument.trim().toUpperCase()
            const claim = parseClaimedStructureInstrument(normalizedClaimInstrument)
            return claim?.legs.includes(legSymbol)
                ? {
                    claimInstrument: normalizedClaimInstrument,
                    claim,
                }
                : null
        })
        .filter((match): match is ClaimedStructureMatch => Boolean(match))
}

function resolveExactSingleLegOwnershipMatch<TPosition extends PositionLike>(
    positions: readonly TPosition[],
    match: ClaimedStructureMatch,
    requestedQuantity: number | undefined
): ClaimedStructureSingleLegOwnershipTarget | null {
    const claimedPositions = resolveClaimedPositionLikes(positions, match.claim)
    if (!claimedPositions) {
        return null
    }

    if (isCompleteClaimCloseGroup(match.claim, claimedPositions)) {
        return buildSingleLegOwnershipTarget(match.claimInstrument, claimedPositions)
    }

    const boundedQuantity = requestedQuantity ?? 0
    if (!isPositiveIntegerQuantity(boundedQuantity)) {
        return null
    }

    if (claimedPositions.some((position) => position.quantity < boundedQuantity)) {
        return null
    }

    const scaledPositions = claimedPositions.map((position) => ({
        ...position,
        quantity: boundedQuantity,
    }))

    return isCompleteClaimCloseGroup(match.claim, scaledPositions)
        ? buildSingleLegOwnershipTarget(match.claimInstrument, claimedPositions)
        : null
}

function resolveMinimumSingleLegOwnershipMatch<TPosition extends PositionLike>(
    positions: readonly TPosition[],
    match: ClaimedStructureMatch
): ClaimedStructureSingleLegOwnershipTarget | null {
    const claimedPositions = resolveClaimedPositionLikes(positions, match.claim)
    if (!claimedPositions) {
        return null
    }

    const quantity = Math.min(...claimedPositions.map((position) => position.quantity))
    if (!isPositiveIntegerQuantity(quantity)) {
        return null
    }

    const scaledPositions = claimedPositions.map((position) => ({
        ...position,
        quantity,
    }))

    return isCompleteClaimCloseGroup(match.claim, scaledPositions)
        ? buildSingleLegOwnershipTarget(match.claimInstrument, claimedPositions)
        : null
}

function resolveClaimedPositionLikes<TPosition extends PositionLike>(
    positions: readonly TPosition[],
    claim: ClaimedStructureInstrument
): TPosition[] | null {
    const positionsBySymbol = new Map(
        positions
            .filter((position) => Boolean(parseOptionContractSymbol(position.instrument)))
            .map((position) => [position.instrument.trim().toUpperCase(), position])
    )
    const claimedPositions = claim.legs
        .map((leg) => positionsBySymbol.get(leg))
        .filter((position): position is TPosition => Boolean(position))

    return claimedPositions.length === claim.legs.length ? claimedPositions : null
}

function buildSingleLegOwnershipTarget<TPosition extends PositionLike>(
    claimInstrument: string,
    positions: readonly TPosition[]
): ClaimedStructureSingleLegOwnershipTarget {
    return {
        claimInstrument,
        legInstruments: positions.map((position) => position.instrument.trim().toUpperCase()),
    }
}

function throwSingleLegAmbiguousStructureClaim<TPosition extends PositionLike>(
    args: ResolveClaimedStructureSingleLegOwnershipArgs<TPosition>,
    legSymbol: string,
    claimInstruments: string[]
): never {
    if (args.onAmbiguous) {
        return args.onAmbiguous(legSymbol, claimInstruments)
    }

    throw createExecutionError("pre_validation", `Alpaca raw option leg close found multiple owned claimed structures for leg ${legSymbol}`, {
        code: "AMBIGUOUS_STRUCTURE_CLAIM",
        retryable: false,
        details: {
            instrument: legSymbol,
            claimInstruments,
        },
    })
}

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
    return resolveGroupFromCanonicalClaim(positions, instrument) ??
        resolveGroupFromRelaxedReference(positions, instrument)
}

export function resolveExactClaimGroupForClose(
    positions: AlpacaPositionResponse[],
    instrument: string,
    quantity: number
): PositionGroup | null {
    return resolveClaimGroupForBoundedQuantity(positions, instrument, quantity)
}

export function resolveMinimumClaimGroupForClose(
    positions: AlpacaPositionResponse[],
    instrument: string
): PositionGroup | null {
    const claim = parseClaimedStructureInstrument(instrument)
    if (!claim) {
        return null
    }

    const claimedPositions = resolveClaimedPositions(positions, claim)
    if (!claimedPositions) {
        return null
    }

    const quantities = claimedPositions.map((position) => parseOptionQuantity(position))
    const quantity = Math.min(...quantities)
    return resolveClaimGroupForBoundedQuantity(positions, instrument, quantity)
}

function resolveGroupFromCanonicalClaim(
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

    return buildScaledPositionGroup({
        structureType: claim.structureType,
        verticalSpreadType: claim.verticalSpreadType,
        underlying: claim.underlying,
        expiration: claim.expiration,
        quantity,
        positions: claimedPositions,
    })
}

function resolveClaimGroupForBoundedQuantity(
    positions: AlpacaPositionResponse[],
    instrument: string,
    quantity: number
): PositionGroup | null {
    const claim = parseClaimedStructureInstrument(instrument)
    if (!claim || !isPositiveIntegerQuantity(quantity)) {
        return null
    }

    const claimedPositions = resolveClaimedPositions(positions, claim)
    if (!claimedPositions) {
        return null
    }

    const claimedEntries = claimedPositions.map(toClaimPositionLike)
    if (claimedEntries.some((entry) => entry.quantity < quantity)) {
        return null
    }

    const scaledEntries = claimedEntries.map((entry) => ({
        ...entry,
        quantity,
    }))
    if (!isCompleteClaimCloseGroup(claim, scaledEntries)) {
        return null
    }

    return buildScaledPositionGroup({
        structureType: claim.structureType,
        verticalSpreadType: claim.verticalSpreadType,
        underlying: claim.underlying,
        expiration: claim.expiration,
        quantity,
        positions: claimedPositions,
    })
}

function resolveClaimedPositions(
    positions: AlpacaPositionResponse[],
    claim: ClaimedStructureInstrument
): AlpacaPositionResponse[] | null {
    const positionsBySymbol = new Map(
        positions
            .filter(isAlpacaOptionPosition)
            .map((position) => [position.symbol.trim().toUpperCase(), position])
    )
    const claimedPositions = claim.legs
        .map((leg) => positionsBySymbol.get(leg))
        .filter((position): position is AlpacaPositionResponse => Boolean(position))

    return claimedPositions.length === claim.legs.length ? claimedPositions : null
}

function isPositiveIntegerQuantity(quantity: number): boolean {
    return Number.isInteger(quantity) && quantity > 0 && Number.isFinite(quantity)
}

type RelaxedCloseReference =
    | { kind: "leg"; symbol: string }
    | {
        kind: "structure"
        structureType: AlpacaStructureType
        verticalSpreadType?: AlpacaVerticalSpreadType
        underlying: string
        expiration: string
    }

function resolveGroupFromRelaxedReference(
    positions: AlpacaPositionResponse[],
    instrument: string
): PositionGroup | null {
    const reference = parseRelaxedCloseReference(instrument)
    if (!reference) {
        return null
    }

    const optionPositions = positions.filter(isAlpacaOptionPosition)
    const rawByEntry = new Map<PositionLike, AlpacaPositionResponse>()
    const entries = optionPositions.map((position) => {
        const entry = toClaimPositionLike(position)
        rawByEntry.set(entry, position)
        return entry
    })

    const matches = deriveAlpacaOptionLegStructures(entries).groups.filter((group) =>
        matchesRelaxedCloseReference(group.structure, reference)
    )
    if (matches.length !== 1) {
        return null
    }

    const match = matches[0]!
    const quantity = Math.min(...match.positions.map((entry) => entry.quantity))
    if (!Number.isFinite(quantity) || quantity <= 0) {
        return null
    }

    return buildScaledPositionGroup({
        structureType: match.structure.structureType,
        verticalSpreadType: match.structure.verticalSpreadType,
        underlying: match.structure.underlying,
        expiration: match.structure.expiration,
        quantity,
        positions: match.positions.map((entry) => rawByEntry.get(entry)!),
    })
}

function parseRelaxedCloseReference(instrument: string): RelaxedCloseReference | null {
    const normalized = instrument.trim().toUpperCase()

    if (parseOptionContractSymbol(normalized)) {
        return { kind: "leg", symbol: normalized }
    }

    const tokens = normalized.split(":")
    if (tokens[0] === "IC" && tokens[1] && tokens[2]) {
        return {
            kind: "structure",
            structureType: "iron_condor",
            underlying: tokens[1],
            expiration: tokens[2],
        }
    }

    if (tokens[0] !== "VS" || !tokens[1] || !tokens[2] || !tokens[3]) {
        return null
    }

    const verticalSpreadType = tokens[1].includes("PUT") || tokens[1] === "BPS"
        ? "bull_put_credit" as const
        : tokens[1].includes("CALL") || tokens[1] === "BCS"
            ? "bear_call_credit" as const
            : undefined
    if (!verticalSpreadType) {
        return null
    }

    return {
        kind: "structure",
        structureType: "credit_vertical",
        verticalSpreadType,
        underlying: tokens[2],
        expiration: tokens[3],
    }
}

function matchesRelaxedCloseReference(
    structure: ResolvedStructure,
    reference: RelaxedCloseReference
): boolean {
    if (reference.kind === "leg") {
        return structure.legs.some((leg) => leg.instrument === reference.symbol)
    }

    if (structure.structureType !== reference.structureType) {
        return false
    }

    if (
        reference.verticalSpreadType &&
        structure.verticalSpreadType !== reference.verticalSpreadType
    ) {
        return false
    }

    return structure.underlying === reference.underlying &&
        structure.expiration === reference.expiration
}

function buildScaledPositionGroup(args: {
    structureType: AlpacaStructureType
    verticalSpreadType?: AlpacaVerticalSpreadType
    underlying: string
    expiration: string
    quantity: number
    positions: AlpacaPositionResponse[]
}): PositionGroup {
    const scaledPositions = args.positions.map((position) => ({
        ...position,
        qty: String(args.quantity),
    }))
    const unrealizedPnl = scaledPositions.reduce((sum, position) => sum + toNumber(position.unrealized_pl), 0)

    return buildPositionGroup({
        structureType: args.structureType,
        verticalSpreadType: args.verticalSpreadType,
        underlying: args.underlying,
        expiration: args.expiration,
        quantity: args.quantity,
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

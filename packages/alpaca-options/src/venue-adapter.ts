import {
    createExecutionError,
    type AccountState,
    type ExecutionResult,
    type OrderIntent,
    type PriceVerification,
    type PriceVerifier,
    type Position,
    type VenueAdapter,
    type WorkingOrder,
} from "@valiq-trading/core"
import {
    AlpacaClient,
    type AlpacaEquityQuote,
    type AlpacaEquitySnapshot,
    type AlpacaOptionContract,
    type AlpacaOptionContractsParams,
    type AlpacaOptionChainParams,
    type AlpacaOptionSnapshotsResponse,
    type AlpacaClockResponse,
    type AlpacaPositionResponse,
} from "./alpaca-client"
import { buildIronCondorInstrumentFromLegs, parseOptionContractSymbol } from "./risk-rules"

interface PositionGroup {
    instrument: string
    underlying: string
    expiration: string
    quantity: number
    positions: AlpacaPositionResponse[]
    entryPrice: number
    currentPrice?: number
    unrealizedPnl?: number
}

interface GroupingResult {
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
}

interface IronCondorUnit {
    callSpread: OptionSpreadUnit
    putSpread: OptionSpreadUnit
}

export class AlpacaOptionsVenueAdapter implements VenueAdapter, PriceVerifier {
    constructor(private readonly client: AlpacaClient) {}

    async getOptionsChain(
        underlyingSymbol: string,
        params: AlpacaOptionChainParams = {}
    ): Promise<{
        contracts: AlpacaOptionContract[]
        snapshots: Record<string, AlpacaOptionSnapshotsResponse["snapshots"][string]>
        nextPageToken?: string
    }> {
        const contractsResponse = await this.client.getOptionContracts({
            underlyingSymbol,
            ...params,
        })
        const snapshotsResponse = await this.client.getOptionSnapshotsByUnderlying(
            underlyingSymbol,
            params
        )

        return {
            contracts: contractsResponse.contracts,
            snapshots: snapshotsResponse.snapshots,
            nextPageToken: contractsResponse.nextPageToken ?? snapshotsResponse.nextPageToken,
        }
    }

    async getOptionContracts(
        params: AlpacaOptionContractsParams
    ): Promise<{ contracts: AlpacaOptionContract[]; nextPageToken?: string }> {
        return await this.client.getOptionContracts(params)
    }

    async getOptionSnapshots(
        symbols: string[]
    ): Promise<AlpacaOptionSnapshotsResponse> {
        return await this.client.getOptionSnapshots(symbols)
    }

    async getQuote(symbol: string): Promise<AlpacaEquityQuote> {
        return await this.client.getLatestEquityQuote(symbol)
    }

    async getEquitySnapshot(symbol: string): Promise<AlpacaEquitySnapshot> {
        return await this.client.getEquitySnapshot(symbol)
    }

    async getPositions(): Promise<Position[]> {
        const rawPositions = await this.client.getPositions()
        const optionPositions = rawPositions.filter(isAlpacaOptionPosition)

        const grouped = groupIronCondorPositions(optionPositions)

        const individual = optionPositions
            .map((position) => toResidualPosition(position, grouped.consumedQuantities))
            .filter((position): position is AlpacaPositionResponse => Boolean(position))
            .map((position) => mapSinglePosition(position))

        return [...grouped.groups.map(mapGroupedPosition), ...individual]
    }

    async getAccountState(): Promise<AccountState> {
        const account = await this.client.getAccount()
        const equity = toNumber(account.equity) || toNumber(account.portfolio_value)
        const balance = toNumber(account.cash)
        const previousBalance = toNumber(account.last_equity)
        const openPnl = toNumber(account.unrealized_pl)

        return {
            balance,
            equity,
            buyingPower: toNumber(account.buying_power) || toNumber(account.regt_buying_power),
            marginUsed: toNumber(account.initial_margin) || toNumber(account.maintenance_margin),
            marginAvailable: Math.max((toNumber(account.buying_power) || 0) - (toNumber(account.initial_margin) || 0), 0),
            openPnl,
            dayPnl: previousBalance > 0 ? equity - previousBalance : 0,
        }
    }

    async getWorkingOrders(): Promise<WorkingOrder[]> {
        const orders = await this.client.getOpenOrders()
        return orders.map((order) => mapWorkingOrder(order))
    }

    async getMarketClock(): Promise<AlpacaClockResponse> {
        return await this.client.getClock()
    }

    async submitOrder(intent: OrderIntent): Promise<ExecutionResult> {
        return await this.client.createOrder(intent)
    }

    async cancelOrder(orderId: string): Promise<ExecutionResult> {
        return await this.client.cancelOrder(orderId)
    }

    async modifyOrder(orderId: string, changes: Partial<OrderIntent>): Promise<ExecutionResult> {
        return await this.client.replaceOrder(orderId, changes)
    }

    async buildCloseIntent(instrument: string): Promise<OrderIntent> {
        const rawPositions = await this.client.getPositions()
        const group = resolveGroupForClose(rawPositions, instrument)

        if (group) {
            return buildGroupCloseIntent(group)
        }

        throw createExecutionError("pre_validation", `No Alpaca multi-leg close structure found for ${instrument}`, {
            code: "POSITION_NOT_FOUND",
            retryable: false,
            details: {
                instrument,
            },
        })
    }

    async closePosition(instrument: string, preparedIntent?: OrderIntent): Promise<ExecutionResult> {
        const closeIntent = preparedIntent ?? await this.buildCloseIntent(instrument)
        return await this.client.createOrder(closeIntent)
    }

    async getOrderStatus(orderId: string): Promise<ExecutionResult> {
        return await this.client.getOrder(orderId)
    }

    async verify(intent: OrderIntent): Promise<PriceVerification> {
        const parsedLegs = (intent.legs ?? []).map((leg) => ({
            leg,
            parsed: parseOptionContractSymbol(leg.instrument),
        }))

        if (parsedLegs.length === 0) {
            return {
                ok: false,
                status: "block",
                livePrices: {},
                proposedPrice: intent.limitPrice,
                message: "Alpaca price verification requires explicit option legs.",
                details: {
                    instrument: intent.instrument,
                },
            }
        }

        const invalidLeg = parsedLegs.find((entry) => !entry.parsed)
        if (invalidLeg) {
            return {
                ok: false,
                status: "block",
                livePrices: {},
                proposedPrice: intent.limitPrice,
                message: `Invalid OCC option symbol: ${invalidLeg.leg.instrument}`,
                details: {
                    invalidSymbol: invalidLeg.leg.instrument,
                },
            }
        }

        const normalizedLegs = parsedLegs.map((entry) => ({
            leg: entry.leg,
            parsed: entry.parsed!,
        }))
        const underlyings = new Set(normalizedLegs.map((entry) => entry.parsed.underlying))
        const expirations = new Set(normalizedLegs.map((entry) => entry.parsed.expiration))

        if (underlyings.size !== 1 || expirations.size !== 1) {
            return {
                ok: false,
                status: "block",
                livePrices: {},
                proposedPrice: intent.limitPrice,
                message: "Submitted Alpaca legs do not share one underlying and expiration.",
                details: {
                    legs: normalizedLegs.map((entry) => ({
                        symbol: entry.leg.instrument,
                        side: entry.leg.side,
                        underlying: entry.parsed.underlying,
                        expiration: entry.parsed.expiration,
                    })),
                },
            }
        }

        const underlyingSymbol = normalizedLegs[0]?.parsed.underlying
        const expirationDate = normalizedLegs[0]?.parsed.expiration

        if (!underlyingSymbol || !expirationDate) {
            return {
                ok: false,
                status: "block",
                livePrices: {},
                proposedPrice: intent.limitPrice,
                message: "Submitted Alpaca structure could not be normalized for price verification.",
            }
        }

        const [contractsResponse, snapshotsResponse, underlyingQuote, underlyingSnapshot] = await Promise.all([
            this.getOptionContracts({
                underlyingSymbol,
                expirationDate,
                limit: 1000,
            }),
            this.getOptionSnapshots(normalizedLegs.map((entry) => entry.leg.instrument)),
            this.getQuote(underlyingSymbol),
            this.getEquitySnapshot(underlyingSymbol),
        ])

        const knownContracts = new Set(
            contractsResponse.contracts.map((contract) => contract.symbol.toUpperCase())
        )
        const missingContracts = normalizedLegs
            .map((entry) => entry.leg.instrument.toUpperCase())
            .filter((symbol) => !knownContracts.has(symbol))

        const legQuotes = normalizedLegs.map((entry) => {
            const symbol = entry.leg.instrument.toUpperCase()
            const snapshot = snapshotsResponse.snapshots[symbol]
            const bid = snapshot?.latestQuote?.bidPrice
            const ask = snapshot?.latestQuote?.askPrice
            const midpoint = bid !== undefined && ask !== undefined
                ? (bid + ask) / 2
                : undefined

            return {
                symbol,
                side: entry.leg.side,
                bid,
                ask,
                midpoint,
                impliedVolatility: snapshot?.impliedVolatility,
                openInterest: snapshot?.openInterest,
            }
        })

        const details: Record<string, unknown> = {
            underlyingSymbol,
            expirationDate,
            underlyingQuote: {
                bid: underlyingQuote.bidPrice,
                ask: underlyingQuote.askPrice,
                lastTradePrice: underlyingSnapshot.latestTrade?.price,
            },
            legs: legQuotes,
        }

        if (missingContracts.length > 0) {
            return {
                ok: false,
                status: "block",
                livePrices: {},
                proposedPrice: intent.limitPrice,
                message: `Alpaca does not recognize these OCC symbols: ${missingContracts.join(", ")}`,
                details: {
                    ...details,
                    missingContracts,
                },
            }
        }

        const missingSnapshots = legQuotes
            .filter((leg) => leg.bid === undefined || leg.ask === undefined)
            .map((leg) => leg.symbol)
        const livePrices = computeAlpacaStructurePrices(legQuotes)
        const proposedPrice = intent.limitPrice
        const drift = livePrices.mid !== undefined && proposedPrice !== undefined
            ? proposedPrice - livePrices.mid
            : undefined
        const driftPercent = livePrices.mid && drift !== undefined
            ? (drift / livePrices.mid) * 100
            : undefined

        if (missingSnapshots.length > 0) {
            return {
                ok: true,
                status: "warn",
                livePrices,
                proposedPrice,
                drift,
                driftPercent,
                message: `Alpaca live snapshots were unavailable for ${missingSnapshots.join(", ")}.`,
                details: {
                    ...details,
                    missingSnapshots,
                },
            }
        }

        return {
            ok: true,
            livePrices,
            proposedPrice,
            drift,
            driftPercent,
            message: livePrices.mid !== undefined && proposedPrice !== undefined
                ? `Compared proposed net price ${proposedPrice} against live midpoint ${roundPrice(livePrices.mid)}.`
                : "Captured live Alpaca structure prices before submission.",
            details,
        }
    }
}

function buildGroupCloseIntent(group: PositionGroup): OrderIntent {
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
            underlying: group.underlying,
            expiration: group.expiration,
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

function isAlpacaOptionPosition(position: AlpacaPositionResponse): boolean {
    return position.asset_class === undefined || position.asset_class === "us_option"
}

function toResidualPosition(
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

function groupIronCondorPositions(positions: AlpacaPositionResponse[]): GroupingResult {
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
        const condors = buildCondorUnits(units)
        const aggregated = aggregateCondorUnits(condors)

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

function buildCondorUnits(units: OptionPositionUnit[]): IronCondorUnit[] {
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

    const maxCondors = Math.min(callShorts.length, callLongs.length, putShorts.length, putLongs.length)
    if (maxCondors === 0) {
        return []
    }

    const callSpreads = pairSpreads(callShorts, callLongs, maxCondors, "call")
    const putSpreads = pairSpreads(putShorts, putLongs, maxCondors, "put")
    return pairCondors(callSpreads, putSpreads)
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
        const [longLeg] = remainingLongs.splice(longIndex, 1)
        if (!longLeg) {
            break
        }

        spreads.push({
            shortLeg,
            longLeg,
        })
    }

    return spreads
}

function selectLongLegIndex(
    shortLeg: OptionPositionUnit,
    longLegs: OptionPositionUnit[],
    optionType: "call" | "put"
): number {
    const preferredIndex = longLegs.findIndex((longLeg) => {
        return optionType === "call"
            ? longLeg.parsed.strike > shortLeg.parsed.strike
            : longLeg.parsed.strike < shortLeg.parsed.strike
    })

    if (preferredIndex >= 0) {
        return preferredIndex
    }

    let closestIndex = 0
    let closestDistance = Number.POSITIVE_INFINITY

    for (let index = 0; index < longLegs.length; index++) {
        const candidate = longLegs[index]
        if (!candidate) {
            continue
        }

        const distance = Math.abs(candidate.parsed.strike - shortLeg.parsed.strike)
        if (distance < closestDistance) {
            closestDistance = distance
            closestIndex = index
        }
    }

    return closestIndex
}

function pairCondors(
    callSpreads: OptionSpreadUnit[],
    putSpreads: OptionSpreadUnit[]
): IronCondorUnit[] {
    const remainingPuts = [...putSpreads]
    const condors: IronCondorUnit[] = []

    for (const callSpread of callSpreads) {
        if (remainingPuts.length === 0) {
            break
        }

        const putIndex = selectPutSpreadIndex(callSpread, remainingPuts)
        const [putSpread] = remainingPuts.splice(putIndex, 1)
        if (!putSpread) {
            continue
        }

        condors.push({
            callSpread,
            putSpread,
        })
    }

    return condors
}

function selectPutSpreadIndex(
    callSpread: OptionSpreadUnit,
    putSpreads: OptionSpreadUnit[]
): number {
    let closestIndex = 0
    let closestDistance = Number.POSITIVE_INFINITY

    for (let index = 0; index < putSpreads.length; index++) {
        const candidate = putSpreads[index]
        if (!candidate) {
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
        .map((groupUnits) => buildPositionGroupFromUnits(groupUnits))
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

function buildPositionGroupFromUnits(units: IronCondorUnit[]): PositionGroup | null {
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
    const entryPrice = positions.reduce((sum, position) => sum + Math.abs(toNumber(position.avg_entry_price)), 0)
    const currentPriceComponents = positions.map((position) => toNumber(position.current_price))
    const currentPrice = currentPriceComponents.every((value) => value > 0)
        ? currentPriceComponents.reduce((sum, value) => sum + value, 0)
        : undefined
    const unrealizedPnl = units.reduce((sum, unit) => {
        const legs = [
            unit.callSpread.shortLeg.position,
            unit.callSpread.longLeg.position,
            unit.putSpread.shortLeg.position,
            unit.putSpread.longLeg.position,
        ]

        return sum + legs.reduce((legSum, leg) => {
            const totalQuantity = parseOptionQuantity(leg)
            if (totalQuantity <= 0) {
                return legSum
            }
            return legSum + (toNumber(leg.unrealized_pl) / totalQuantity)
        }, 0)
    }, 0)

    return {
        instrument: buildIronCondorInstrumentFromLegs(underlying, expiration, positions.map((position) => ({
            instrument: position.symbol,
        }))),
        underlying,
        expiration,
        quantity,
        positions,
        entryPrice: roundPrice(entryPrice),
        currentPrice: currentPrice !== undefined ? roundPrice(currentPrice) : undefined,
        unrealizedPnl: roundPrice(unrealizedPnl),
    }
}

function mapGroupedPosition(group: PositionGroup): Position {
    return {
        instrument: group.instrument,
        side: "short",
        quantity: group.quantity,
        entryPrice: group.entryPrice,
        currentPrice: group.currentPrice,
        unrealizedPnl: group.unrealizedPnl,
        metadata: {
            structureType: "iron_condor",
            underlying: group.underlying,
            expiration: group.expiration,
            legs: group.positions.map((position) => ({
                symbol: position.symbol,
                side: position.side,
                qty: Math.abs(toNumber(position.qty)),
            })),
        },
    }
}

function mapSinglePosition(position: AlpacaPositionResponse): Position {
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

function mapWorkingOrder(order: Awaited<ReturnType<AlpacaClient["getOpenOrders"]>>[number]): WorkingOrder {
    const submittedAt = resolveOrderTimestamp(order)
    const quantity = order.qty ? Number(order.qty) : 0
    const filledQuantity = Number(order.filled_qty ?? 0)

    return {
        orderId: order.id,
        instrument: resolveOrderInstrument(order),
        status: mapAlpacaOrderStatus(order.status),
        quantity,
        filledQuantity,
        remainingQuantity: Math.max(quantity - filledQuantity, 0),
        submittedAt,
        updatedAt: submittedAt,
        side: order.side === "buy" || order.side === "sell" ? order.side : undefined,
        limitPrice: order.limit_price ? roundPrice(Math.abs(Number(order.limit_price))) : undefined,
        stopPrice: order.stop_price ? Number(order.stop_price) : undefined,
        avgFillPrice: order.filled_avg_price ? Number(order.filled_avg_price) : undefined,
        metadata: {
            legs: order.legs,
        },
    }
}

function resolveOrderInstrument(
    order: Awaited<ReturnType<AlpacaClient["getOpenOrders"]>>[number]
): string {
    if (!order.legs || order.legs.length === 0) {
        return order.id
    }

    const parsedLegs = order.legs
        .map((leg) => parseOptionContractSymbol(leg.symbol))
        .filter((value): value is NonNullable<ReturnType<typeof parseOptionContractSymbol>> => Boolean(value))

    if (parsedLegs.length === 4) {
        const underlying = parsedLegs[0]?.underlying
        const expiration = parsedLegs[0]?.expiration
        const sharedExpiration = parsedLegs.every((leg) => leg.expiration === expiration)

        if (underlying && expiration && sharedExpiration) {
            return buildIronCondorInstrumentFromLegs(underlying, expiration, order.legs.map((leg) => ({
                instrument: leg.symbol,
            })))
        }
    }

    return order.legs.map((leg) => leg.symbol).join(" | ")
}

function resolveGroupForClose(
    positions: AlpacaPositionResponse[],
    instrument: string
): PositionGroup | null {
    const grouped = groupIronCondorPositions(positions.filter(isAlpacaOptionPosition)).groups
    const normalizedInstrument = instrument.trim().toUpperCase()
    const directMatch = grouped.find((group) => group.instrument === instrument)
    if (directMatch) {
        return directMatch
    }

    const byUnderlying = grouped.filter((group) => group.underlying === instrument.toUpperCase())
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

function computeAlpacaStructurePrices(
    legs: Array<{
        side: string
        bid?: number
        ask?: number
        midpoint?: number
    }>
): PriceVerification["livePrices"] {
    if (legs.length === 0) {
        return {}
    }

    const rawBid = legs.every((leg) => leg.bid !== undefined && leg.ask !== undefined)
        ? roundPrice(legs.reduce((sum, leg) => {
            return sum + (leg.side.startsWith("sell") ? (leg.bid ?? 0) : -(leg.ask ?? 0))
        }, 0))
        : undefined
    const rawAsk = legs.every((leg) => leg.bid !== undefined && leg.ask !== undefined)
        ? roundPrice(legs.reduce((sum, leg) => {
            return sum + (leg.side.startsWith("sell") ? (leg.ask ?? 0) : -(leg.bid ?? 0))
        }, 0))
        : undefined
    const rawMid = legs.every((leg) => leg.midpoint !== undefined)
        ? roundPrice(legs.reduce((sum, leg) => {
            return sum + (leg.side.startsWith("sell") ? 1 : -1) * (leg.midpoint ?? 0)
        }, 0))
        : undefined
    const bid = rawBid !== undefined && rawAsk !== undefined
        ? roundPrice(Math.min(Math.abs(rawBid), Math.abs(rawAsk)))
        : rawBid !== undefined
            ? roundPrice(Math.abs(rawBid))
            : undefined
    const ask = rawBid !== undefined && rawAsk !== undefined
        ? roundPrice(Math.max(Math.abs(rawBid), Math.abs(rawAsk)))
        : rawAsk !== undefined
            ? roundPrice(Math.abs(rawAsk))
            : undefined
    const mid = rawMid !== undefined
        ? roundPrice(Math.abs(rawMid))
        : undefined
    const spread = bid !== undefined && ask !== undefined
        ? roundPrice(Math.abs(ask - bid))
        : undefined

    return {
        bid,
        ask,
        mid,
        spread,
    }
}

function toNumber(value: string | undefined): number {
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

function roundPrice(price: number): number {
    return Math.round(price * 100) / 100
}

function mapAlpacaOrderStatus(
    status: string
): ExecutionResult["status"] {
    switch (status) {
        case "filled":
            return "filled"
        case "partially_filled":
            return "partially_filled"
        case "canceled":
        case "cancelled":
        case "pending_cancel":
            return "cancelled"
        case "expired":
            return "expired"
        case "rejected":
        case "suspended":
            return "rejected"
        default:
            return "pending"
    }
}

function resolveOrderTimestamp(
    order: Awaited<ReturnType<AlpacaClient["getOpenOrders"]>>[number]
): number {
    const rawTimestamp = order.updated_at ?? order.submitted_at
    const parsed = rawTimestamp ? Date.parse(rawTimestamp) : Number.NaN
    return Number.isFinite(parsed) ? parsed : Date.now()
}

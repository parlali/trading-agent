import {
    ACTIVE_ORDER_STATUSES,
    createExecutionError,
    ExecutionCostTracker,
    getExecutionErrorDetail,
    type AccountPnlEvent,
    type AccountState,
    type ExecutionCostAssessment,
    type ExecutionCostSnapshot,
    type ExecutionResult,
    type OrderIntent,
    type PriceVerification,
    type PriceVerifier,
    type Position,
    type ProviderPositionClosure,
    type SubmitOrderContext,
    type SubmitRecoveryResult,
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
} from "./alpaca-client"
import {
    parseOptionContractSymbol,
} from "./risk-rules"
import {
    mapOrderStatus as mapAlpacaOrderStatus,
} from "./alpaca-order-mappers"
import {
    buildGroupCloseIntent,
    ALPACA_ACCOUNT_PNL_ACTIVITY_TYPES,
    ALPACA_OPTION_CLOSURE_ACTIVITY_TYPES,
    computeAlpacaStructurePrices,
    isAlpacaOptionPosition,
    mapAlpacaAccountPnlEvent,
    mapAlpacaOptionActivityClosure,
    mapSinglePosition,
    mapWorkingOrder,
    resolveGroupForClose,
    roundPrice,
    toNumber,
} from "./venue-adapter-mappers"

export class AlpacaOptionsVenueAdapter implements VenueAdapter, PriceVerifier {
    readonly identityCapability = "native_client_id" as const

    constructor(
        private readonly client: AlpacaClient,
        private readonly executionCostTracker: ExecutionCostTracker = new ExecutionCostTracker()
    ) {}

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

    assessEquityQuoteExecutionCost(
        symbol: string,
        quote: AlpacaEquityQuote
    ): ExecutionCostAssessment {
        return this.executionCostTracker.assessSnapshot({
            app: "alpaca-options",
            instrument: symbol.trim().toUpperCase(),
            instrumentClass: "equity",
            capturedAt: Date.now(),
            bestBid: quote.bidPrice,
            bestAsk: quote.askPrice,
            midpoint: quote.bidPrice !== undefined && quote.askPrice !== undefined
                ? (quote.bidPrice + quote.askPrice) / 2
                : undefined,
            referencePrice: quote.bidPrice !== undefined && quote.askPrice !== undefined
                ? (quote.bidPrice + quote.askPrice) / 2
                : undefined,
            absoluteSpread: quote.bidPrice !== undefined && quote.askPrice !== undefined
                ? Math.max(quote.askPrice - quote.bidPrice, 0)
                : undefined,
            nativeSpread: quote.bidPrice !== undefined && quote.askPrice !== undefined
                ? Math.max(quote.askPrice - quote.bidPrice, 0)
                : undefined,
            nativeSpreadUnit: "price",
        })
    }

    assessOptionQuoteExecutionCost(
        symbol: string,
        snapshot?: AlpacaOptionSnapshotsResponse["snapshots"][string]
    ): ExecutionCostAssessment {
        const bid = snapshot?.latestQuote?.bidPrice
        const ask = snapshot?.latestQuote?.askPrice
        const midpoint = bid !== undefined && ask !== undefined
            ? (bid + ask) / 2
            : undefined
        const lastTradePrice = snapshot?.latestTrade?.price

        return this.executionCostTracker.assessSnapshot({
            app: "alpaca-options",
            instrument: symbol.trim().toUpperCase(),
            instrumentClass: "equity_option",
            capturedAt: Date.now(),
            bestBid: bid,
            bestAsk: ask,
            midpoint,
            referencePrice: midpoint ?? lastTradePrice,
            absoluteSpread: bid !== undefined && ask !== undefined
                ? Math.max(ask - bid, 0)
                : undefined,
            nativeSpread: bid !== undefined && ask !== undefined
                ? Math.max(ask - bid, 0)
                : undefined,
            nativeSpreadUnit: "price",
        })
    }

    assessStructureExecutionCost(
        instrument: string,
        livePrices: PriceVerification["livePrices"]
    ): ExecutionCostAssessment {
        return this.executionCostTracker.assessSnapshot({
            app: "alpaca-options",
            instrument,
            instrumentClass: "option_structure",
            capturedAt: Date.now(),
            bestBid: livePrices.bid,
            bestAsk: livePrices.ask,
            midpoint: livePrices.mid,
            referencePrice: livePrices.mid,
            absoluteSpread: livePrices.spread,
            nativeSpread: livePrices.spread,
            nativeSpreadUnit: "price",
        })
    }

    async getPositions(): Promise<Position[]> {
        const rawPositions = await this.client.getPositions()
        const optionPositions = rawPositions.filter(isAlpacaOptionPosition)
        return optionPositions.map((position) => mapSinglePosition(position))
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
        const activeOpenOrders = orders.filter((order) =>
            ACTIVE_ORDER_STATUSES.includes(mapAlpacaOrderStatus(order.status))
        )
        const verifiedOrders = await Promise.all(activeOpenOrders.map(async (order) => ({
            order,
            status: await this.client.getOrder(order.id),
        })))

        return verifiedOrders
            .filter(({ status }) => ACTIVE_ORDER_STATUSES.includes(status.status))
            .map(({ order, status }) => mapWorkingOrder(order, status))
    }

    async getRecentPositionClosures(): Promise<ProviderPositionClosure[]> {
        const activities = await this.client.getAccountActivities([...ALPACA_OPTION_CLOSURE_ACTIVITY_TYPES])
        return activities
            .map((activity) => mapAlpacaOptionActivityClosure(activity))
            .filter((closure): closure is ProviderPositionClosure => closure !== undefined)
    }

    async getAccountPnlEvents(): Promise<AccountPnlEvent[]> {
        const activities = await this.client.getAccountActivities([...ALPACA_ACCOUNT_PNL_ACTIVITY_TYPES])
        return activities
            .map((activity) => mapAlpacaAccountPnlEvent(activity))
            .filter((event): event is AccountPnlEvent => event !== undefined)
    }

    async getMarketClock(): Promise<AlpacaClockResponse> {
        return await this.client.getClock()
    }

    async submitOrder(intent: OrderIntent, context?: SubmitOrderContext): Promise<ExecutionResult> {
        if (!context?.identity.providerClientOrderId) {
            throw createExecutionError("pre_validation", "Alpaca live submission requires canonical execution identity", {
                code: "MISSING_CANONICAL_ORDER_ID",
                retryable: false,
                details: {
                    instrument: intent.instrument,
                },
            })
        }

        return await this.client.createOrder(intent, context)
    }

    classifySubmitError(error: unknown): "commit_unknown" | "rejected" | undefined {
        const detail = getExecutionErrorDetail(error)
        return detail?.retryable ? "commit_unknown" : "rejected"
    }

    async recoverSubmittedOrder(
        intent: OrderIntent,
        context: SubmitOrderContext
    ): Promise<SubmitRecoveryResult> {
        try {
            const byClientOrderId = await this.client.getOrderByClientOrderId(context.identity.providerClientOrderId)
            return {
                outcome: "accepted",
                result: byClientOrderId,
            }
        } catch {
            const recent = await this.client.getOpenOrders()
            const matches = recent.filter((order) => order.client_order_id === context.identity.providerClientOrderId)
            if (matches.length === 1) {
                return {
                    outcome: "accepted",
                    result: {
                        orderId: matches[0]!.id,
                        providerOrderId: matches[0]!.id,
                        providerClientOrderId: matches[0]!.client_order_id,
                        status: "pending",
                        filledQuantity: Number(matches[0]!.filled_qty ?? 0),
                        timestamp: Date.now(),
                    },
                }
            }

            return {
                outcome: matches.length === 0 ? "not_found" : "ambiguous",
                message: matches.length === 0
                    ? "Alpaca recovery found no order with the canonical client_order_id"
                    : "Alpaca recovery found multiple orders with the canonical client_order_id",
                details: {
                    providerClientOrderId: context.identity.providerClientOrderId,
                    instrument: intent.instrument,
                    matchIds: matches.map((order) => order.id),
                },
            }
        }
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

    async closePosition(instrument: string, preparedIntent?: OrderIntent, context?: SubmitOrderContext): Promise<ExecutionResult> {
        const closeIntent = preparedIntent ?? await this.buildCloseIntent(instrument)
        return await this.client.createOrder(closeIntent, context)
    }

    async closeProviderPosition(position: Position, preparedIntent?: OrderIntent, context?: SubmitOrderContext): Promise<ExecutionResult> {
        const closeIntent = preparedIntent?.legs && preparedIntent.legs.length > 0
            ? preparedIntent
            : await resolveProviderCloseIntent(this, position)

        return await this.client.createOrder(closeIntent, context)
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
        const executionCost = this.assessStructureExecutionCost(intent.instrument, livePrices)
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
                executionCost,
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
            executionCost,
            message: livePrices.mid !== undefined && proposedPrice !== undefined
                ? `Compared proposed net price ${proposedPrice} against live midpoint ${roundPrice(livePrices.mid)}.`
                : "Captured live Alpaca structure prices before submission.",
            details,
        }
    }
}

async function resolveSingleLegCloseLimitPrice(
    adapter: AlpacaOptionsVenueAdapter,
    position: Position
): Promise<number> {
    if (position.currentPrice !== undefined && position.currentPrice > 0) {
        return roundPrice(position.currentPrice)
    }

    const snapshots = await adapter.getOptionSnapshots([position.instrument])
    const snapshot = snapshots.snapshots[position.instrument]
    const bid = snapshot?.latestQuote?.bidPrice
    const ask = snapshot?.latestQuote?.askPrice
    const midpoint = bid !== undefined && ask !== undefined
        ? (bid + ask) / 2
        : undefined
    const price = midpoint ?? snapshot?.latestTrade?.price

    if (price !== undefined && price > 0) {
        return roundPrice(price)
    }

    throw createExecutionError("pre_validation", `No current Alpaca option leg price found for ${position.instrument}`, {
        code: "POSITION_PRICE_UNAVAILABLE",
        retryable: false,
        details: {
            instrument: position.instrument,
            providerPositionId: position.providerPositionId,
        },
    })
}

function resolveSingleLegCloseSide(position: Position): NonNullable<OrderIntent["legs"]>[number]["side"] {
    return position.side === "long" ? "sell_to_close" : "buy_to_close"
}

function assertAlpacaOptionPosition(position: Position): void {
    if (parseOptionContractSymbol(position.instrument)) {
        return
    }

    throw createExecutionError("pre_validation", `Alpaca provider-position close requires an OCC option symbol or exact claimed structure evidence for ${position.instrument}`, {
        code: "ALPACA_CLOSE_INSTRUMENT_UNSUPPORTED",
        retryable: false,
        details: {
            instrument: position.instrument,
            providerPositionId: position.providerPositionId,
        },
    })
}

async function buildSingleLegProviderCloseIntent(
    adapter: AlpacaOptionsVenueAdapter,
    position: Position
): Promise<OrderIntent> {
    assertAlpacaOptionPosition(position)
    const symbol = position.instrument.trim().toUpperCase()
    const limitPrice = await resolveSingleLegCloseLimitPrice(adapter, {
        ...position,
        instrument: symbol,
    })

    return {
        instrument: symbol,
        side: position.side === "long" ? "sell" : "buy",
        quantity: position.quantity,
        orderType: "limit",
        limitPrice,
        timeInForce: "day",
        legs: [{
            instrument: symbol,
            side: resolveSingleLegCloseSide(position),
            quantity: 1,
        }],
        metadata: {
            ...position.metadata,
            action: "close",
            providerPositionId: position.providerPositionId,
            entryPrice: position.entryPrice,
            positionSide: position.side,
            estimatedPrice: limitPrice,
            structureType: "single_option",
        },
    }
}

async function resolveProviderCloseIntent(
    adapter: AlpacaOptionsVenueAdapter,
    position: Position
): Promise<OrderIntent> {
    const claimInstrument = readMetadataString(position.metadata, "alpacaClaimInstrument") ??
        readMetadataString(position.metadata, "claimInstrument")

    if (claimInstrument) {
        return await adapter.buildCloseIntent(claimInstrument)
    }

    if (position.instrument.startsWith("IC:") || position.instrument.startsWith("VS:")) {
        return await adapter.buildCloseIntent(position.instrument)
    }

    return await buildSingleLegProviderCloseIntent(adapter, position)
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

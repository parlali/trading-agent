import {
    createExecutionError,
    createExecutionErrorDetail,
    ExecutionCostTracker,
    formatExecutionError,
    getExecutionErrorDetail,
    readTrimmedString,
    type AccountState,
    type DryRunOrderSimulator,
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
import type {
    CreateOrderParams,
    PolymarketClient,
    PolymarketCurrentPosition,
    PolymarketOpenOrder,
    PolymarketOrderBook,
    PolymarketTrade,
    PreparedPolymarketOrder,
} from "./polymarket-client"
import { getPolymarketMarketPrice, type PolymarketMarketPrice } from "./market-price"
import {
    buildCanonicalMetadataFromCurrentPosition,
    mapCurrentPosition,
    mapOpenOrderStatus,
    mapOpenOrderToExecutionResult,
    mapOrderType,
    mapPostOrderStatus,
    mapSettlementPositionClosure,
    readPolymarketOrderSalt,
    readPolymarketSignedOrderFingerprint,
} from "./venue-adapter-mappers"
import { getPolymarketOrderSemanticsError } from "./order-semantics"
import { resolvePolymarketExecutablePrice } from "./polymarket-pricing"
import {
    buildPolymarketFeeMetadata,
    matchesPolymarketRecoveryTradeGeometry,
    mergePolymarketRecoveryOrderIds,
    quantitiesMatch,
    readPolymarketTradeOrderId,
    readRecord,
    resolvePostOrderFillSummary,
    resolvePreparedSignedOrderSize,
    summarizePolymarketTradesForOrder,
} from "./venue-adapter-accounting"
import {
    buildPolymarketMarketSearchResult,
    createPolymarketSearchMarketsLivePriceBudget,
    POLYMARKET_SEARCH_MARKETS_MAX_LIVE_PRICE_TOKENS,
    resolvePolymarketCanonicalOrderMetadata,
    resolvePolymarketSearchMarkets,
    type PolymarketMarketSearchResult,
    type PolymarketSearchMarketsLivePriceBudget,
} from "./venue-adapter-market-metadata"

export { buildPolymarketFeeMetadata } from "./venue-adapter-accounting"
const POLYMARKET_QUANTITY_EPSILON = 1e-9
interface PolymarketRecoveryIdentity {
    salt: string
    signedOrderFingerprint?: string
    signedOrderMetadata?: Record<string, unknown>
}

export class PolymarketVenueAdapter implements VenueAdapter, PriceVerifier, DryRunOrderSimulator {
    readonly identityCapability = "deterministic_signed_id" as const
    private positionsCache: { positions: Position[]; fetchedAt: number } | null = null
    private currentPositionsCache: { positions: PolymarketCurrentPosition[]; fetchedAt: number } | null = null
    private currentPositionsInFlight: Promise<PolymarketCurrentPosition[]> | null = null
    private readonly preparedOrders = new Map<string, PreparedPolymarketOrder>()
    private readonly POSITIONS_CACHE_TTL = 5000
    private readonly marketPriceCacheTtlMs = 15_000
    private readonly marketPriceCache = new Map<string, { value: PolymarketMarketPrice; fetchedAt: number }>()
    private readonly inFlightMarketPriceLookups = new Map<string, Promise<PolymarketMarketPrice>>()

    constructor(
        private readonly client: PolymarketClient,
        private readonly executionCostTracker: ExecutionCostTracker = new ExecutionCostTracker()
    ) {}

    async prepareOrderIdentity(intent: OrderIntent, context: SubmitOrderContext) {
        const params = await this.buildCreateOrderParams(intent, context.identity.canonicalOrderId)
        const prepared = await this.client.prepareOrder(params)
        this.preparedOrders.set(context.identity.canonicalOrderId, prepared)

        return {
            providerClientOrderId: prepared.signedOrderFingerprint,
            signedOrderFingerprint: prepared.signedOrderFingerprint,
            signedOrderMetadata: prepared.signedOrderMetadata,
        }
    }

    async getPrice(tokenId: string, side: "buy" | "sell"): Promise<number> {
        return this.client.getPrice(tokenId, side)
    }

    async getMarketPrice(
        tokenId: string,
        side?: "buy" | "sell",
        options: {
            warmupSampleCount?: number
        } = {}
    ): Promise<PolymarketMarketPrice> {
        return await getPolymarketMarketPrice({
            client: this.client,
            executionCostTracker: this.executionCostTracker,
            tokenId,
            side,
            warmupSampleCount: options.warmupSampleCount,
        })
    }

    async getOrderBook(tokenId: string): Promise<PolymarketOrderBook> {
        return await this.client.getOrderBook(tokenId)
    }

    async searchMarkets(params: {
        category?: string
        query?: string
        conditionId?: string
        marketSlug?: string
        limit?: number
        includeLivePrices?: boolean
        livePriceTokenLimit?: number
    }): Promise<PolymarketMarketSearchResult[]> {
        const livePriceBudget = createPolymarketSearchMarketsLivePriceBudget({
            ...params,
            maxLivePriceTokens: POLYMARKET_SEARCH_MARKETS_MAX_LIVE_PRICE_TOKENS,
        })

        if (params.conditionId) {
            const market = await this.client.getMarket(params.conditionId)
            return [await this.buildSearchResult(market, livePriceBudget)]
        }

        if (params.marketSlug) {
            const market = await this.client.getMarketBySlug(params.marketSlug)
            return market ? [await this.buildSearchResult(market, livePriceBudget)] : []
        }

        const limit = params.limit ?? 10
        const category = params.category?.trim().toLowerCase()
        const query = params.query?.trim().toLowerCase()

        if (!category && !query) {
            throw new Error("search_markets requires category, query, conditionId, or marketSlug")
        }

        const markets = await resolvePolymarketSearchMarkets(this.client, {
            category,
            query,
            limit,
        })

        return await Promise.all(
            markets
                .slice(0, limit)
                .map(async (market) => await this.buildSearchResult(market, livePriceBudget))
        )
    }

    async getPositions(): Promise<Position[]> {
        if (
            this.positionsCache &&
            Date.now() - this.positionsCache.fetchedAt < this.POSITIONS_CACHE_TTL
        ) {
            return this.positionsCache.positions
        }

        const positions = (await this.getCurrentPositionsCached())
            .filter((position) => position.size > 0)
            .filter((position) => !position.redeemable && !position.mergeable)
            .map((position) => mapCurrentPosition(position))

        this.positionsCache = { positions, fetchedAt: Date.now() }
        return positions
    }

    async getAccountState(): Promise<AccountState> {
        const [usdcBalance, currentPositions] = await Promise.all([
            this.client.getBalance(),
            this.getCurrentPositionsCached(),
        ])

        let openPnl = 0
        let tokenValue = 0

        for (const position of currentPositions) {
            if (position.size <= 0) {
                continue
            }

            tokenValue += Number.isFinite(position.currentValue)
                ? position.currentValue
                : position.size * position.avgPrice + position.cashPnl
            if (!position.redeemable && !position.mergeable) {
                openPnl += position.cashPnl
            }
        }

        const totalEquity = usdcBalance + tokenValue

        return {
            balance: usdcBalance,
            equity: totalEquity,
            buyingPower: usdcBalance,
            marginUsed: tokenValue,
            marginAvailable: usdcBalance,
            openPnl,
            dayPnl: 0,
        }
    }

    async getRecentPositionClosures(): Promise<ProviderPositionClosure[]> {
        const positions = await this.getCurrentPositionsCached()
        return positions
            .map((position) => mapSettlementPositionClosure(position))
            .filter((closure): closure is ProviderPositionClosure => closure !== undefined)
    }

    async getWorkingOrders(): Promise<WorkingOrder[]> {
        const orders = await this.client.getOpenOrders()
        const filledAssetIds = Array.from(new Set(orders
            .filter((order) => Number(order.size_matched) > 0)
            .map((order) => order.asset_id)))
        const tradesByAssetId = new Map<string, PolymarketTrade[]>()
        await Promise.all(filledAssetIds.map(async (assetId) => {
            tradesByAssetId.set(assetId, await this.client.getTrades({ assetId }))
        }))

        return orders.map((order) => {
            const quantity = Number(order.original_size)
            const filledQuantity = Number(order.size_matched)
            const submittedAt = Date.parse(order.created_at)
            const signedOrderFingerprint = readPolymarketSignedOrderFingerprint(order)
            const tradeSummary = summarizePolymarketTradesForOrder(order.id, tradesByAssetId.get(order.asset_id) ?? [])

            return {
                orderId: order.id,
                providerOrderId: order.id,
                providerClientOrderId: signedOrderFingerprint,
                signedOrderFingerprint,
                instrument: order.asset_id,
                status: mapOpenOrderStatus(order),
                quantity,
                filledQuantity,
                remainingQuantity: Math.max(quantity - filledQuantity, 0),
                submittedAt: Number.isFinite(submittedAt) ? submittedAt : Date.now(),
                updatedAt: Number.isFinite(submittedAt) ? submittedAt : Date.now(),
                side: order.side.toLowerCase() === "buy" ? "buy" : "sell",
                limitPrice: Number(order.price),
                avgFillPrice: tradeSummary?.fillPrice,
                metadata: {
                    market: order.market,
                    outcome: order.outcome,
                    orderType: order.order_type,
                    expiration: order.expiration,
                    signedOrderFingerprint,
                    ...(filledQuantity > 0 ? tradeSummary?.metadata ?? {
                        providerAccountingMissing: true,
                        providerAccountingMissingReason: "polymarket_working_order_fill_requires_data_trade_reconciliation",
                    } : {}),
                },
            }
        })
    }

    async submitOrder(intent: OrderIntent, context?: SubmitOrderContext): Promise<ExecutionResult> {
        if (!context?.identity.canonicalOrderId) {
            throw createExecutionError("pre_validation", "Polymarket live submission requires canonical execution identity", {
                code: "MISSING_CANONICAL_ORDER_ID",
                retryable: false,
                details: {
                    instrument: intent.instrument,
                },
            })
        }

        const prepared = this.preparedOrders.get(context.identity.canonicalOrderId)
        if (!prepared) {
            throw createExecutionError("pre_validation", "Polymarket live submission requires a prepared signed order", {
                code: "MISSING_PREPARED_SIGNED_ORDER",
                retryable: false,
                details: {
                    canonicalOrderId: context.identity.canonicalOrderId,
                    instrument: intent.instrument,
                },
            })
        }

        const preparedSize = resolvePreparedSignedOrderSize(prepared.signedOrderMetadata)
        if (preparedSize === undefined || preparedSize <= 0) {
            this.discardPreparedOrder(context)
            throw createExecutionError("pre_validation", "Polymarket prepared signed order size is unavailable", {
                code: "PREPARED_SIGNED_ORDER_SIZE_UNAVAILABLE",
                retryable: false,
                details: {
                    canonicalOrderId: context.identity.canonicalOrderId,
                    instrument: intent.instrument,
                    signedOrderFingerprint: prepared.signedOrderFingerprint,
                    signedOrderMetadata: prepared.signedOrderMetadata,
                },
            })
        }

        if (!quantitiesMatch(preparedSize, intent.quantity)) {
            this.discardPreparedOrder(context)
            throw createExecutionError("pre_validation", "Polymarket intent quantity does not match prepared signed order size", {
                code: "PREPARED_SIGNED_ORDER_SIZE_MISMATCH",
                retryable: false,
                details: {
                    canonicalOrderId: context.identity.canonicalOrderId,
                    instrument: intent.instrument,
                    intentQuantity: intent.quantity,
                    preparedSize,
                    signedOrderFingerprint: prepared.signedOrderFingerprint,
                },
            })
        }

        let response: Awaited<ReturnType<PolymarketClient["postPreparedOrder"]>>
        try {
            response = await this.client.postPreparedOrder(prepared)
        } finally {
            this.preparedOrders.delete(context.identity.canonicalOrderId)
        }
        const recentTrades = response.status === "matched"
            ? await this.client.getTrades({ assetId: intent.instrument })
            : []
        const fillSummary = resolvePostOrderFillSummary({
            response,
            side: intent.side,
            trades: recentTrades,
        })
        if (response.status === "matched" && !fillSummary) {
            throw createExecutionError("venue", "Polymarket matched order response did not include matched amount or trade evidence", {
                code: "POLYMARKET_MATCHED_FILL_EVIDENCE_MISSING",
                retryable: true,
                details: {
                    orderId: response.orderID,
                    canonicalOrderId: context.identity.canonicalOrderId,
                    instrument: intent.instrument,
                    responseStatus: response.status,
                },
            })
        }
        const filledQuantity = fillSummary?.filledQuantity ?? 0
        const status = response.status === "matched" && filledQuantity > 0 && !quantitiesMatch(filledQuantity, preparedSize)
            ? "partially_filled"
            : mapPostOrderStatus(response.status)

        return {
            orderId: response.orderID,
            providerOrderId: response.orderID,
            providerClientOrderId: response.signedOrderFingerprint,
            signedOrderFingerprint: response.signedOrderFingerprint,
            signedOrderMetadata: response.signedOrderMetadata,
            status,
            filledQuantity,
            fillPrice: fillSummary?.fillPrice,
            timestamp: Date.now(),
            intentUpdates: {
                metadata: {
                    ...buildPolymarketFeeMetadata(prepared.signedOrderMetadata),
                    ...fillSummary?.metadata,
                },
            },
        }
    }

    private async buildCreateOrderParams(
        intent: OrderIntent,
        canonicalOrderId: string
    ): Promise<CreateOrderParams> {
        this.assertSupportedOrderSemantics(intent)
        const canonical = resolvePolymarketCanonicalOrderMetadata(intent)
        const tokenId = intent.instrument
        const polyOrderType = mapOrderType(intent)
        let price = intent.limitPrice
        if (price === undefined || price <= 0) {
            const currentPrice = await this.client.getPrice(tokenId, intent.side)
            price = resolvePolymarketExecutablePrice(intent.side, currentPrice)
        }

        return {
            tokenId,
            canonicalOrderId,
            side: intent.side,
            size: intent.quantity,
            price,
            orderType: polyOrderType,
            expiration: canonical.expiration,
            negRisk: canonical.negRisk,
        }
    }

    private assertSupportedOrderSemantics(intent: OrderIntent): void {
        const reason = getPolymarketOrderSemanticsError(intent)
        if (!reason) {
            return
        }

        throw createExecutionError("pre_validation", reason, {
            code: "POLYMARKET_UNSUPPORTED_ORDER_SEMANTICS",
            retryable: false,
            details: {
                instrument: intent.instrument,
                orderType: intent.orderType,
                stopPrice: intent.stopPrice,
                timeInForce: intent.timeInForce,
            },
        })
    }

    classifySubmitError(error: unknown): "commit_unknown" | "rejected" | undefined {
        const detail = getExecutionErrorDetail(error)
        if (!detail) {
            return "commit_unknown"
        }
        if (detail?.code === "INVALID_ORDER_DUPLICATED") {
            return "commit_unknown"
        }

        return detail.retryable ? "commit_unknown" : "rejected"
    }

    async recoverSubmittedOrder(
        intent: OrderIntent,
        context: SubmitOrderContext,
        error: unknown
    ): Promise<SubmitRecoveryResult> {
        const detail = getExecutionErrorDetail(error)
        const providerSignedOrderFingerprint = readTrimmedString(detail?.details?.signedOrderFingerprint)
        const persistedSignedOrderFingerprint = context.identity.signedOrderFingerprint
        const signedOrderFingerprint = providerSignedOrderFingerprint ?? persistedSignedOrderFingerprint
        const errorSignedOrderMetadata = readRecord(detail?.details?.signedOrderMetadata)
        const signedOrderMetadata = context.identity.signedOrderMetadata ?? errorSignedOrderMetadata
        const salt = readTrimmedString(signedOrderMetadata?.salt)

        if (
            providerSignedOrderFingerprint &&
            persistedSignedOrderFingerprint &&
            providerSignedOrderFingerprint !== persistedSignedOrderFingerprint
        ) {
            return {
                outcome: "not_found",
                message: "Polymarket recovery refused because the submitted signed-order fingerprint does not match persisted identity",
                details: {
                    canonicalOrderId: context.identity.canonicalOrderId,
                    signedOrderFingerprint,
                    persistedSignedOrderFingerprint,
                },
            }
        }

        if (!salt) {
            return {
                outcome: "not_found",
                message: "Polymarket recovery could not prove a unique provider order without persisted signed-order salt",
                details: {
                    canonicalOrderId: context.identity.canonicalOrderId,
                    signedOrderFingerprint,
                    hasSignedOrderMetadata: signedOrderMetadata !== undefined,
                    tokenId: intent.instrument,
                },
            }
        }

        return await this.recoverDuplicatedSignedOrder(intent, context, {
            salt,
            signedOrderFingerprint,
            signedOrderMetadata,
        })
    }

    async simulateDryRunOrder(intent: OrderIntent, context?: SubmitOrderContext): Promise<ExecutionResult> {
        const canonical = resolvePolymarketCanonicalOrderMetadata(intent)
        this.assertSupportedOrderSemantics(intent)
        if (!context?.identity.canonicalOrderId) {
            throw createExecutionError("pre_validation", "Polymarket dry-run simulation requires canonical execution identity", {
                code: "MISSING_CANONICAL_ORDER_ID",
                retryable: false,
                details: {
                    tokenId: canonical.tokenId,
                },
            })
        }

        const marketPrice = await this.getMarketPrice(canonical.tokenId, intent.side)
        const fillPrice = intent.limitPrice ?? marketPrice.executablePrice ?? marketPrice.midpoint

        if (!Number.isFinite(fillPrice) || fillPrice <= 0) {
            const errorDetail = createExecutionErrorDetail("pre_validation", "Polymarket dry-run simulation requires a finite token price", {
                code: "POLYMARKET_DRY_RUN_PRICE_UNAVAILABLE",
                retryable: true,
                details: {
                    tokenId: canonical.tokenId,
                    conditionId: canonical.conditionId,
                    marketSlug: canonical.marketSlug,
                },
            })

            return {
                orderId: "",
                status: "rejected",
                filledQuantity: 0,
                timestamp: Date.now(),
                error: formatExecutionError(errorDetail),
                errorDetail,
            }
        }

        const feeRateBps = await this.resolveDryRunFeeRateBps(canonical.tokenId)

        return {
            orderId: context.identity.canonicalOrderId,
            canonicalOrderId: context.identity.canonicalOrderId,
            providerClientOrderId: context.identity.providerClientOrderId,
            submitAttemptId: context.identity.submitAttemptId,
            submitAttemptSequence: context.identity.submitAttemptSequence,
            commitOutcome: "accepted",
            status: "filled",
            filledQuantity: intent.quantity,
            fillPrice,
            timestamp: Date.now(),
            intentUpdates: {
                metadata: buildPolymarketFeeMetadata({
                    feeRateBps,
                    size: intent.quantity,
                    price: fillPrice,
                }),
            },
        }
    }

    private async resolveDryRunFeeRateBps(tokenId: string): Promise<number | undefined> {
        try {
            return await this.client.getFeeRateBps(tokenId)
        } catch {
            return undefined
        }
    }

    async cancelOrder(orderId: string): Promise<ExecutionResult> {
        await this.client.cancelOrder(orderId)

        try {
            const order = await this.client.getOrder(orderId)
            return mapOpenOrderToExecutionResult(order)
        } catch (error) {
            throw createExecutionError("venue", "Polymarket cancel status could not be confirmed after cancel request", {
                code: "POLYMARKET_CANCEL_STATUS_UNCONFIRMED",
                retryable: true,
                details: {
                    orderId,
                    error: error instanceof Error ? error.message : String(error),
                },
            })
        }
    }

    async modifyOrder(orderId: string, _changes: Partial<OrderIntent>): Promise<ExecutionResult> {
        const errorDetail = createExecutionErrorDetail("pre_validation", "Polymarket modify requires explicit cancel and a new canonical submission", {
            code: "POLYMARKET_MODIFY_REQUIRES_NEW_SUBMISSION",
            retryable: false,
            details: {
                orderId,
            },
        })

        return {
            orderId,
            status: "rejected",
            filledQuantity: 0,
            timestamp: Date.now(),
            error: formatExecutionError(errorDetail),
            errorDetail,
        }
    }

    async closePosition(instrument: string, preparedIntent?: OrderIntent, context?: SubmitOrderContext): Promise<ExecutionResult> {
        const intent = preparedIntent ?? await this.buildCloseIntent(instrument)
        const balance = await this.client.getTokenBalance(instrument)

        if (balance <= 0) {
            this.discardPreparedOrder(context)
            const errorDetail = createExecutionErrorDetail("pre_validation", `No position found for token ${instrument}`, {
                code: "POSITION_NOT_FOUND",
                retryable: false,
                details: {
                    instrument,
                },
            })
            return {
                orderId: "",
                status: "rejected",
                filledQuantity: 0,
                timestamp: Date.now(),
                error: formatExecutionError(errorDetail),
                errorDetail,
            }
        }

        if (!Number.isFinite(intent.quantity) || intent.quantity <= 0) {
            this.discardPreparedOrder(context)
            const errorDetail = createExecutionErrorDetail("pre_validation", `Close quantity for token ${instrument} must be positive`, {
                code: "INVALID_CLOSE_QUANTITY",
                retryable: false,
                details: {
                    instrument,
                    quantity: intent.quantity,
                },
            })
            return {
                orderId: "",
                status: "rejected",
                filledQuantity: 0,
                timestamp: Date.now(),
                error: formatExecutionError(errorDetail),
                errorDetail,
            }
        }

        if (balance + POLYMARKET_QUANTITY_EPSILON < intent.quantity) {
            this.discardPreparedOrder(context)
            const errorDetail = createExecutionErrorDetail("pre_validation", `Polymarket token ${instrument} balance is below prepared close quantity`, {
                code: "POLYMARKET_CLOSE_BALANCE_BELOW_PREPARED_QUANTITY",
                retryable: true,
                details: {
                    instrument,
                    balance,
                    quantity: intent.quantity,
                },
            })
            return {
                orderId: "",
                status: "rejected",
                filledQuantity: 0,
                timestamp: Date.now(),
                error: formatExecutionError(errorDetail),
                errorDetail,
            }
        }

        return this.submitOrder(intent, context)
    }

    async buildCloseIntent(instrument: string): Promise<OrderIntent> {
        const position = (await this.getPositions()).find((entry) => entry.instrument === instrument) ?? null
        if (!position) {
            throw createExecutionError("pre_validation", `Cannot close Polymarket token ${instrument}: provider position identity is unavailable`, {
                code: "POLYMARKET_CLOSE_IDENTITY_UNAVAILABLE",
                retryable: true,
                details: {
                    instrument,
                },
            })
        }

        let sellPrice: number | undefined
        try {
            sellPrice = await this.client.getPrice(instrument, "sell")
        } catch (error) {
            throw createExecutionError("pre_validation", `Cannot close Polymarket token ${instrument}: sell price lookup failed`, {
                code: "POLYMARKET_CLOSE_PRICE_UNAVAILABLE",
                retryable: true,
                details: {
                    instrument,
                    error: error instanceof Error ? error.message : String(error),
                },
            })
        }

        return {
            instrument,
            side: "sell",
            quantity: position.quantity,
            orderType: "limit",
            limitPrice: resolvePolymarketExecutablePrice("sell", sellPrice),
            timeInForce: "ioc",
            metadata: buildCanonicalMetadataFromCurrentPosition(position),
        }
    }

    async getOrderStatus(orderId: string): Promise<ExecutionResult> {
        const order = await this.client.getOrder(orderId)
        return mapOpenOrderToExecutionResult(order)
    }

    async verify(intent: OrderIntent): Promise<PriceVerification> {
        const canonical = resolvePolymarketCanonicalOrderMetadata(intent)
        const marketPrice = await this.getMarketPrice(intent.instrument, intent.side)
        const proposedPrice = intent.orderType === "limit" || intent.orderType === "stop_limit"
            ? intent.limitPrice
            : undefined
        const drift = proposedPrice !== undefined
            ? proposedPrice - marketPrice.midpoint
            : undefined
        const driftPercent = marketPrice.midpoint > 0 && drift !== undefined
            ? (drift / marketPrice.midpoint) * 100
            : undefined

        return {
            ok: true,
            status: proposedPrice === undefined ? "skipped" : undefined,
            livePrices: {
                bid: marketPrice.bestBid,
                ask: marketPrice.bestAsk,
                mid: marketPrice.midpoint,
                spread: marketPrice.spread,
            },
            proposedPrice,
            drift,
            driftPercent,
            executionCost: marketPrice.executionCost,
            message: proposedPrice === undefined
                ? "Captured live Polymarket prices before submission. No limit price was provided for drift comparison."
                : `Compared proposed Polymarket price ${proposedPrice} against live midpoint ${marketPrice.midpoint}.`,
            details: {
                tokenId: canonical.tokenId,
                conditionId: canonical.conditionId,
                marketSlug: canonical.marketSlug,
                question: canonical.question,
                outcome: canonical.outcome,
                executablePrice: marketPrice.executablePrice,
                executableSide: marketPrice.executableSide,
            },
        }
    }

    private async findOpenOrdersForRecovery(intent: OrderIntent): Promise<PolymarketOpenOrder[]> {
        const price = intent.limitPrice
        const orders = await this.client.getOpenOrders({
            assetId: intent.instrument,
        })
        return orders.filter((order) => {
            if (order.side.toLowerCase() !== intent.side) {
                return false
            }

            if (price !== undefined && Math.abs(Number(order.price) - price) > 1e-9) {
                return false
            }

            return Math.abs(Number(order.original_size) - intent.quantity) <= 1e-9
        })
    }

    private async recoverDuplicatedSignedOrder(
        intent: OrderIntent,
        context: SubmitOrderContext,
        identity: PolymarketRecoveryIdentity
    ): Promise<SubmitRecoveryResult> {
        const [openOrders, recentTrades] = await Promise.all([
            this.findOpenOrdersForRecovery(intent),
            this.client.getTrades({
                assetId: intent.instrument,
            }),
        ])
        const openMatches = openOrders.filter((order) =>
            readPolymarketOrderSalt(order) === identity.salt
        )
        const saltTradeMatches = recentTrades.filter((trade) =>
            readPolymarketOrderSalt(trade) === identity.salt
        )

        const recoveredResults: ExecutionResult[] = openMatches.map((order) => ({
            ...mapOpenOrderToExecutionResult(order),
            providerClientOrderId: identity.signedOrderFingerprint ?? identity.salt,
            signedOrderFingerprint: identity.signedOrderFingerprint,
            signedOrderMetadata: identity.signedOrderMetadata,
            commitOutcome: "recovered",
        }))
        const terminalCandidateOrderIds = mergePolymarketRecoveryOrderIds([
            ...saltTradeMatches.map(readPolymarketTradeOrderId),
            ...recentTrades
                .filter((trade) => matchesPolymarketRecoveryTradeGeometry(trade, intent))
                .map(readPolymarketTradeOrderId),
        ]).filter((orderId) => !openMatches.some((order) => order.id === orderId))

        for (const orderId of terminalCandidateOrderIds) {
            const recovery = await this.recoverPolymarketMatchedOrder(
                context,
                orderId,
                identity
            )
            if (recovery.outcome === "accepted") {
                recoveredResults.push(recovery.result)
            }
        }

        if (recoveredResults.length === 1) {
            return {
                outcome: "accepted",
                result: recoveredResults[0]!,
            }
        }

        if (recoveredResults.length > 1) {
            return {
                outcome: "ambiguous",
                message: "Polymarket recovery found multiple provider orders proving the same signed-order salt",
                matches: recoveredResults,
                details: {
                    canonicalOrderId: context.identity.canonicalOrderId,
                    salt: identity.salt,
                    signedOrderFingerprint: identity.signedOrderFingerprint,
                    openCandidateCount: openOrders.length,
                    exactOpenMatchCount: openMatches.length,
                    saltTradeMatchCount: saltTradeMatches.length,
                    terminalCandidateOrderIds,
                    tokenId: intent.instrument,
                },
            }
        }

        return {
            outcome: "not_found",
            message: "Polymarket recovery could not prove a unique provider order for the signed-order salt",
            details: {
                canonicalOrderId: context.identity.canonicalOrderId,
                salt: identity.salt,
                signedOrderFingerprint: identity.signedOrderFingerprint,
                openCandidateCount: openOrders.length,
                exactOpenMatchCount: openMatches.length,
                saltTradeMatchCount: saltTradeMatches.length,
                terminalCandidateOrderIds,
                tokenId: intent.instrument,
            },
        }
    }

    private async recoverPolymarketMatchedOrder(
        context: SubmitOrderContext,
        orderId: string,
        identity: PolymarketRecoveryIdentity
    ): Promise<SubmitRecoveryResult> {
        try {
            const order = await this.client.getOrder(orderId)
            if (readPolymarketOrderSalt(order) === identity.salt) {
                return {
                    outcome: "accepted",
                    result: {
                        ...mapOpenOrderToExecutionResult(order),
                        providerClientOrderId: identity.signedOrderFingerprint ?? identity.salt,
                        signedOrderFingerprint: identity.signedOrderFingerprint,
                        signedOrderMetadata: identity.signedOrderMetadata,
                        commitOutcome: "recovered",
                    },
                }
            }
        } catch {
            return {
                outcome: "not_found",
                message: "Polymarket recovery found matching activity but provider order lookup did not prove the signed-order salt",
                details: {
                    canonicalOrderId: context.identity.canonicalOrderId,
                    salt: identity.salt,
                    signedOrderFingerprint: identity.signedOrderFingerprint,
                    orderId,
                },
            }
        }

        return {
            outcome: "not_found",
            message: "Polymarket recovery found matching activity but provider order lookup returned a different signed-order salt",
            details: {
                canonicalOrderId: context.identity.canonicalOrderId,
                salt: identity.salt,
                signedOrderFingerprint: identity.signedOrderFingerprint,
                orderId,
            },
        }
    }

    private async getCurrentPositionsCached(): Promise<PolymarketCurrentPosition[]> {
        if (
            this.currentPositionsCache &&
            Date.now() - this.currentPositionsCache.fetchedAt < this.POSITIONS_CACHE_TTL
        ) {
            return this.currentPositionsCache.positions
        }

        if (!this.currentPositionsInFlight) {
            this.currentPositionsInFlight = this.client.getCurrentPositions()
                .then((positions) => {
                    this.currentPositionsCache = { positions, fetchedAt: Date.now() }
                    this.positionsCache = null
                    return positions
                })
                .finally(() => {
                    this.currentPositionsInFlight = null
                })
        }

        return await this.currentPositionsInFlight
    }

    private async buildSearchResult(
        market: Parameters<typeof buildPolymarketMarketSearchResult>[0]["market"],
        livePriceBudget?: PolymarketSearchMarketsLivePriceBudget
    ): Promise<PolymarketMarketSearchResult> {
        return await buildPolymarketMarketSearchResult({
            market,
            livePriceBudget,
            maybeGetLivePrice: async (tokenId, budget) =>
                await this.maybeGetSearchMarketsLivePrice(tokenId, budget),
        })
    }

    private async maybeGetSearchMarketsLivePrice(
        tokenId: string,
        livePriceBudget?: PolymarketSearchMarketsLivePriceBudget
    ): Promise<PolymarketMarketPrice | undefined> {
        if (!livePriceBudget) {
            return undefined
        }

        const cached = this.readCachedMarketPrice(tokenId)
        if (cached) {
            return cached
        }

        if (livePriceBudget.remainingTokens <= 0 || livePriceBudget.remainingRequests < 1) {
            return undefined
        }

        livePriceBudget.remainingTokens -= 1
        livePriceBudget.remainingRequests -= 1

        try {
            return await this.getCachedMarketPrice(tokenId)
        } catch {
            return undefined
        }
    }

    private readCachedMarketPrice(tokenId: string): PolymarketMarketPrice | undefined {
        const cached = this.marketPriceCache.get(tokenId)
        if (!cached) {
            return undefined
        }

        if (Date.now() - cached.fetchedAt >= this.marketPriceCacheTtlMs) {
            this.marketPriceCache.delete(tokenId)
            return undefined
        }

        return cached.value
    }

    private async getCachedMarketPrice(tokenId: string): Promise<PolymarketMarketPrice> {
        const cached = this.readCachedMarketPrice(tokenId)
        if (cached) {
            return cached
        }

        const inFlight = this.inFlightMarketPriceLookups.get(tokenId)
        if (inFlight) {
            return await inFlight
        }

        const lookup = this.getMarketPrice(tokenId, undefined, {
            warmupSampleCount: 1,
        })
            .then((price) => {
                this.marketPriceCache.set(tokenId, {
                    value: price,
                    fetchedAt: Date.now(),
                })
                return price
            })
            .finally(() => {
                this.inFlightMarketPriceLookups.delete(tokenId)
            })

        this.inFlightMarketPriceLookups.set(tokenId, lookup)
        return await lookup
    }

    private discardPreparedOrder(context?: SubmitOrderContext): void {
        if (context?.identity.canonicalOrderId) {
            this.preparedOrders.delete(context.identity.canonicalOrderId)
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

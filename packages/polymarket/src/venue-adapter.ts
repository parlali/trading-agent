import {
    createExecutionError,
    createExecutionErrorDetail,
    ExecutionCostTracker,
    formatExecutionError,
    getExecutionErrorDetail,
    readFiniteNumber,
    readTrimmedString,
    type AccountState,
    type DryRunOrderSimulator,
    type ExecutionCostAssessment,
    type ExecutionResult,
    type OrderIntent,
    type PriceVerification,
    type PriceVerifier,
    type Position,
    type SubmitOrderContext,
    type SubmitRecoveryResult,
    type VenueAdapter,
    type WorkingOrder,
} from "@valiq-trading/core"
import type {
    CreateOrderParams,
    PolymarketClient,
    PolymarketMarket,
    PolymarketOpenOrder,
    PolymarketOrderBook,
    PolymarketTrade,
    PreparedPolymarketOrder,
} from "./polymarket-client"
import { getPolymarketMarketPrice, type PolymarketMarketPrice } from "./market-price"
import {
    buildCanonicalMetadataFromCurrentPosition,
    dedupeAndRankMarkets,
    mapCurrentPosition,
    mapOpenOrderStatus,
    mapOpenOrderToExecutionResult,
    mapOrderType,
    mapPostOrderStatus,
    matchesMarketQuery,
    readPolymarketSignedOrderFingerprint,
} from "./venue-adapter-mappers"
import { AMOUNT_MULTIPLIER } from "./polymarket-order-signing"

export interface PolymarketMarketSearchResult {
    conditionId: string
    question: string
    category: string
    description: string
    marketSlug: string
    active: boolean
    closed: boolean
    negRisk: boolean
    minimumOrderSize: number
    minimumTickSize: number
    volume?: number
    liquidity?: number
    endDateIso: string
    tokens: Array<{
        tokenId: string
        outcome: string
        midpoint?: number
        bestBid?: number
        bestAsk?: number
        spread?: number
        executionCost?: ExecutionCostAssessment
    }>
}

export const POLYMARKET_SEARCH_MARKETS_MAX_LIVE_PRICE_TOKENS = 4
export const POLYMARKET_SEARCH_MARKETS_LIVE_PRICE_REQUEST_BUDGET =
    POLYMARKET_SEARCH_MARKETS_MAX_LIVE_PRICE_TOKENS
const POLYMARKET_QUANTITY_EPSILON = 1e-9

interface PolymarketSearchMarketsLivePriceBudget {
    remainingTokens: number
    remainingRequests: number
}

export class PolymarketVenueAdapter implements VenueAdapter, PriceVerifier, DryRunOrderSimulator {
    readonly identityCapability = "deterministic_signed_id" as const
    private positionsCache: { positions: Position[]; fetchedAt: number } | null = null
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
        const livePriceBudget = this.createSearchMarketsLivePriceBudget(params)

        if (params.conditionId) {
            const market = await this.client.getMarket(params.conditionId)
            return [await this.buildMarketSearchResult(market, livePriceBudget)]
        }

        if (params.marketSlug) {
            const market = await this.client.getMarketBySlug(params.marketSlug)
            return market ? [await this.buildMarketSearchResult(market, livePriceBudget)] : []
        }

        const limit = params.limit ?? 10
        const category = params.category?.trim().toLowerCase()
        const query = params.query?.trim().toLowerCase()

        if (!category && !query) {
            throw new Error("search_markets requires category, query, conditionId, or marketSlug")
        }

        const markets = await this.resolveSearchMarkets({
            category,
            query,
            limit,
        })

        return await Promise.all(
            markets
                .slice(0, limit)
                .map(async (market) => await this.buildMarketSearchResult(market, livePriceBudget))
        )
    }

    async getPositions(): Promise<Position[]> {
        if (
            this.positionsCache &&
            Date.now() - this.positionsCache.fetchedAt < this.POSITIONS_CACHE_TTL
        ) {
            return this.positionsCache.positions
        }

        const positions = (await this.client.getCurrentPositions())
            .filter((position) => position.size > 0)
            .filter((position) => !position.redeemable && !position.mergeable)
            .map((position) => mapCurrentPosition(position))

        this.positionsCache = { positions, fetchedAt: Date.now() }
        return positions
    }

    async getAccountState(): Promise<AccountState> {
        const [usdcBalance, positions] = await Promise.all([
            this.client.getBalance(),
            this.getPositions(),
        ])

        let openPnl = 0
        let totalExposure = 0

        for (const pos of positions) {
            openPnl += pos.unrealizedPnl ?? 0
            totalExposure += pos.quantity * pos.entryPrice
        }

        const totalEquity = usdcBalance + totalExposure + openPnl

        return {
            balance: usdcBalance,
            equity: totalEquity,
            buyingPower: usdcBalance,
            marginUsed: totalExposure,
            marginAvailable: usdcBalance,
            openPnl,
            dayPnl: 0,
        }
    }

    async getWorkingOrders(): Promise<WorkingOrder[]> {
        const orders = await this.client.getOpenOrders()
        return orders.map((order) => {
            const quantity = Number(order.original_size)
            const filledQuantity = Number(order.size_matched)
            const submittedAt = Date.parse(order.created_at)
            const signedOrderFingerprint = readPolymarketSignedOrderFingerprint(order)

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
                metadata: {
                    market: order.market,
                    outcome: order.outcome,
                    orderType: order.order_type,
                    expiration: order.expiration,
                    signedOrderFingerprint,
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
        const price = readFiniteNumber(prepared.signedOrderMetadata.price)

        return {
            orderId: response.orderID,
            providerOrderId: response.orderID,
            providerClientOrderId: response.signedOrderFingerprint,
            signedOrderFingerprint: response.signedOrderFingerprint,
            signedOrderMetadata: response.signedOrderMetadata,
            status: mapPostOrderStatus(response.status),
            filledQuantity: response.status === "matched" ? preparedSize : 0,
            fillPrice: response.status === "matched" ? price : undefined,
            timestamp: Date.now(),
        }
    }

    private async buildCreateOrderParams(
        intent: OrderIntent,
        canonicalOrderId: string
    ): Promise<CreateOrderParams> {
        const canonical = this.resolveCanonicalOrderMetadata(intent)
        const tokenId = intent.instrument
        const polyOrderType = mapOrderType(intent)
        let price = intent.limitPrice
        if (price === undefined || price <= 0) {
            const currentPrice = await this.client.getPrice(tokenId, intent.side)
            price = intent.side === "buy"
                ? Math.min(currentPrice * 1.02, 0.99)
                : Math.max(currentPrice * 0.98, 0.01)
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

    classifySubmitError(error: unknown): "commit_unknown" | "rejected" | undefined {
        const detail = getExecutionErrorDetail(error)
        if (detail?.code === "INVALID_ORDER_DUPLICATED") {
            return "commit_unknown"
        }

        return detail?.retryable ? "commit_unknown" : "rejected"
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

        if (signedOrderFingerprint) {
            if (
                !persistedSignedOrderFingerprint ||
                persistedSignedOrderFingerprint !== signedOrderFingerprint
            ) {
                return {
                    outcome: "not_found",
                    message: "Polymarket recovery refused because the signed-order fingerprint was not persisted before post",
                    details: {
                        canonicalOrderId: context.identity.canonicalOrderId,
                        signedOrderFingerprint,
                        persistedSignedOrderFingerprint,
                    },
                }
            }

            return await this.recoverDuplicatedSignedOrder(intent, context, signedOrderFingerprint)
        }

        return {
            outcome: "not_found",
            message: "Polymarket recovery could not prove a unique provider order for the deterministic signed-order fingerprint",
            details: {
                canonicalOrderId: context.identity.canonicalOrderId,
                signedOrderFingerprint,
                tokenId: intent.instrument,
            },
        }
    }

    async simulateDryRunOrder(intent: OrderIntent, context?: SubmitOrderContext): Promise<ExecutionResult> {
        const canonical = this.resolveCanonicalOrderMetadata(intent)
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
        }
    }

    async cancelOrder(orderId: string): Promise<ExecutionResult> {
        await this.client.cancelOrder(orderId)

        // Fetch the order after cancellation to get final state
        try {
            const order = await this.client.getOrder(orderId)
            return mapOpenOrderToExecutionResult(order)
        } catch {
            // If the order is already gone, return a cancelled result
            return {
                orderId,
                status: "cancelled",
                filledQuantity: 0,
                timestamp: Date.now(),
            }
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
        const position = await this.resolveCurrentPositionForToken(instrument)
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
            limitPrice: Math.max(sellPrice, 0.01),
            timeInForce: "ioc",
            metadata: buildCanonicalMetadataFromCurrentPosition(position),
        }
    }

    async getOrderStatus(orderId: string): Promise<ExecutionResult> {
        const order = await this.client.getOrder(orderId)
        return mapOpenOrderToExecutionResult(order)
    }

    async verify(intent: OrderIntent): Promise<PriceVerification> {
        const canonical = this.resolveCanonicalOrderMetadata(intent)
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
        signedOrderFingerprint: string
    ): Promise<SubmitRecoveryResult> {
        const [openOrders, recentTrades] = await Promise.all([
            this.findOpenOrdersForRecovery(intent),
            this.client.getTrades({
                assetId: intent.instrument,
            }),
        ])
        const openMatches = openOrders.filter((order) =>
            readPolymarketSignedOrderFingerprint(order) === signedOrderFingerprint
        )
        const tradeMatches = recentTrades.filter((trade) =>
            readPolymarketSignedOrderFingerprint(trade) === signedOrderFingerprint
        )

        const openMatchesById = new Map(openMatches.map((order) => [order.id, order]))
        const exactOrderIds = mergePolymarketRecoveryOrderIds([
            ...openMatches.map((order) => order.id),
            ...tradeMatches.map(readPolymarketTradeOrderId),
        ])

        if (exactOrderIds.length === 1) {
            const orderId = exactOrderIds[0]!
            const openOrder = openMatchesById.get(orderId)
            if (openOrder) {
                return {
                    outcome: "accepted",
                    result: {
                        ...mapOpenOrderToExecutionResult(openOrder),
                        providerClientOrderId: signedOrderFingerprint,
                        signedOrderFingerprint,
                        commitOutcome: "recovered",
                    },
                }
            }

            return await this.recoverPolymarketMatchedOrder(
                context,
                orderId,
                signedOrderFingerprint
            )
        }

        return {
            outcome: exactOrderIds.length > 1 ? "ambiguous" : "not_found",
            message: "Polymarket recovery could not prove a unique provider order for the exact signed-order fingerprint",
            details: {
                canonicalOrderId: context.identity.canonicalOrderId,
                signedOrderFingerprint,
                openCandidateCount: openOrders.length,
                exactOpenMatchCount: openMatches.length,
                exactTradeMatchCount: tradeMatches.length,
                exactOrderIds,
                tokenId: intent.instrument,
            },
        }
    }

    private async recoverPolymarketMatchedOrder(
        context: SubmitOrderContext,
        orderId: string,
        signedOrderFingerprint: string
    ): Promise<SubmitRecoveryResult> {
        try {
            const order = await this.client.getOrder(orderId)
            if (readPolymarketSignedOrderFingerprint(order) === signedOrderFingerprint) {
                return {
                    outcome: "accepted",
                    result: {
                        ...mapOpenOrderToExecutionResult(order),
                        providerClientOrderId: signedOrderFingerprint,
                        signedOrderFingerprint,
                        commitOutcome: "recovered",
                    },
                }
            }
        } catch {
            return {
                outcome: "not_found",
                message: "Polymarket recovery found matching activity but provider order lookup did not prove the signed-order fingerprint",
                details: {
                    canonicalOrderId: context.identity.canonicalOrderId,
                    signedOrderFingerprint,
                    orderId,
                },
            }
        }

        return {
            outcome: "not_found",
            message: "Polymarket recovery found matching activity but provider order lookup returned a different signed-order fingerprint",
            details: {
                canonicalOrderId: context.identity.canonicalOrderId,
                signedOrderFingerprint,
                orderId,
            },
        }
    }

    private async resolveSearchMarkets(params: {
        category?: string
        query?: string
        limit: number
    }): Promise<PolymarketMarket[]> {
        if (params.category && params.query) {
            const [queryMarkets, categoryMarkets] = await Promise.all([
                this.client.searchMarkets(params.query, params.limit),
                this.client.getTopLiquidMarketsForCategory(params.category, params.limit),
            ])

            return dedupeAndRankMarkets([
                ...queryMarkets,
                ...categoryMarkets.filter((market) => matchesMarketQuery(market, params.query!)),
            ])
        }

        if (params.category) {
            return await this.client.getTopLiquidMarketsForCategory(params.category, params.limit)
        }

        return await this.client.searchMarkets(params.query!, params.limit)
    }

    private async resolveCurrentPositionForToken(tokenId: string): Promise<Position | null> {
        const positions = await this.getPositions()
        return positions.find((position) => position.instrument === tokenId) ?? null
    }

    private async resolveCanonicalMetadataForToken(
        tokenId: string,
        conditionId: string,
        outcome: string
    ): Promise<Record<string, unknown>> {
        const position = await this.resolveCurrentPositionForToken(tokenId)
        if (position?.metadata?.tokenId === tokenId) {
            return position.metadata
        }

        const market = await this.client.getMarket(conditionId)
        const token = market.tokens.find((candidate) => candidate.tokenId === tokenId)
        if (!token) {
            throw new Error(`Polymarket token ${tokenId} was not found in market ${conditionId}`)
        }

        return {
            tokenId,
            conditionId: market.conditionId,
            marketSlug: market.marketSlug,
            question: market.question,
            outcome: token.outcome || outcome,
            category: market.category,
            endDateIso: market.endDateIso,
            liquidity: market.liquidity,
            volume: market.volume,
            negRisk: market.negRisk,
        }
    }

    private resolveCanonicalOrderMetadata(intent: OrderIntent): {
        tokenId: string
        conditionId: string
        marketSlug: string
        question: string
        outcome: string
        category?: string
        endDateIso?: string
        liquidity?: number
        volume?: number
        negRisk?: boolean
        expiration?: number
    } {
        const metadata = intent.metadata ?? {}
        const tokenId = readTrimmedString(metadata.tokenId) ?? intent.instrument
        const conditionId = readTrimmedString(metadata.conditionId)
        const marketSlug = readTrimmedString(metadata.marketSlug)
        const question = readTrimmedString(metadata.question)
        const outcome = readTrimmedString(metadata.outcome)

        if (!tokenId || tokenId !== intent.instrument || !conditionId || !marketSlug || !question || !outcome) {
            throw new Error("Polymarket orders require canonical tokenId, conditionId, marketSlug, question, and outcome metadata from market discovery")
        }

        return {
            tokenId,
            conditionId,
            marketSlug,
            question,
            outcome,
            category: readTrimmedString(metadata.category),
            endDateIso: readTrimmedString(metadata.endDateIso),
            liquidity: readFiniteNumber(metadata.liquidity),
            volume: readFiniteNumber(metadata.volume),
            negRisk: typeof metadata.negRisk === "boolean" ? metadata.negRisk : undefined,
            expiration: readFiniteNumber(metadata.expiration),
        }
    }

    private async buildMarketSearchResult(
        market: PolymarketMarket,
        livePriceBudget?: PolymarketSearchMarketsLivePriceBudget
    ): Promise<PolymarketMarketSearchResult> {
        const tokens = await Promise.all(
            market.tokens.map(async (token) => {
                const price = await this.maybeGetSearchMarketsLivePrice(token.tokenId, livePriceBudget)

                return {
                    tokenId: token.tokenId,
                    outcome: token.outcome,
                    midpoint: price?.midpoint,
                    bestBid: price?.bestBid,
                    bestAsk: price?.bestAsk,
                    spread: price?.spread,
                    executionCost: price?.executionCost,
                }
            })
        )

        return {
            conditionId: market.conditionId,
            question: market.question,
            category: market.category,
            description: market.description,
            marketSlug: market.marketSlug,
            active: market.active,
            closed: market.closed,
            negRisk: market.negRisk,
            minimumOrderSize: market.minimumOrderSize,
            minimumTickSize: market.minimumTickSize,
            volume: market.volume,
            liquidity: market.liquidity,
            endDateIso: market.endDateIso,
            tokens,
        }
    }

    private createSearchMarketsLivePriceBudget(params: {
        includeLivePrices?: boolean
        livePriceTokenLimit?: number
    }): PolymarketSearchMarketsLivePriceBudget | undefined {
        if (params.includeLivePrices !== true) {
            return undefined
        }

        const requestedTokenLimit = params.livePriceTokenLimit ?? POLYMARKET_SEARCH_MARKETS_MAX_LIVE_PRICE_TOKENS
        const boundedTokenLimit = Math.min(
            requestedTokenLimit,
            POLYMARKET_SEARCH_MARKETS_MAX_LIVE_PRICE_TOKENS
        )

        return {
            remainingTokens: boundedTokenLimit,
            remainingRequests: boundedTokenLimit,
        }
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

function mergePolymarketRecoveryOrderIds(orderIds: Array<string | undefined>): string[] {
    const ids = new Set<string>()

    for (const orderId of orderIds) {
        const normalized = readTrimmedString(orderId)
        if (normalized) {
            ids.add(normalized)
        }
    }

    return Array.from(ids).sort((left, right) => left.localeCompare(right))
}

function resolvePreparedSignedOrderSize(metadata: Record<string, unknown>): number | undefined {
    const explicitSize = readFiniteNumber(metadata.size)
    if (explicitSize !== undefined) {
        return explicitSize
    }

    const side = readTrimmedString(metadata.side)
    const rawSize = side === "sell"
        ? readFiniteNumber(metadata.makerAmount)
        : side === "buy"
            ? readFiniteNumber(metadata.takerAmount)
            : undefined

    return rawSize !== undefined
        ? rawSize / AMOUNT_MULTIPLIER
        : undefined
}

function quantitiesMatch(left: number, right: number): boolean {
    return Math.abs(left - right) <= POLYMARKET_QUANTITY_EPSILON
}

function readPolymarketTradeOrderId(trade: PolymarketTrade): string | undefined {
    return readTrimmedString(trade.maker_order_id) ?? readTrimmedString(trade.taker_order_id)
}

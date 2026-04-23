import {
    createExecutionError,
    createExecutionErrorDetail,
    ExecutionCostTracker,
    formatExecutionError,
    type AccountState,
    type DryRunOrderSimulator,
    type ExecutionCostAssessment,
    type ExecutionResult,
    type OrderIntent,
    type PriceVerification,
    type PriceVerifier,
    type Position,
    type VenueAdapter,
    type WorkingOrder,
} from "@valiq-trading/core"
import type {
    PolymarketClient,
    PolymarketCurrentPosition,
    PolymarketMarket,
    PolymarketOpenOrder,
    PolymarketOrderBook,
} from "./polymarket-client"
import { getPolymarketMarketPrice, type PolymarketMarketPrice } from "./market-price"

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

interface PolymarketSearchMarketsLivePriceBudget {
    remainingTokens: number
    remainingRequests: number
}

export class PolymarketVenueAdapter implements VenueAdapter, PriceVerifier, DryRunOrderSimulator {
    private positionsCache: { positions: Position[]; fetchedAt: number } | null = null
    private readonly POSITIONS_CACHE_TTL = 5000
    private readonly marketPriceCacheTtlMs = 15_000
    private readonly marketPriceCache = new Map<string, { value: PolymarketMarketPrice; fetchedAt: number }>()
    private readonly inFlightMarketPriceLookups = new Map<string, Promise<PolymarketMarketPrice>>()

    constructor(
        private readonly client: PolymarketClient,
        private readonly executionCostTracker: ExecutionCostTracker = new ExecutionCostTracker()
    ) {}

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

            return {
                orderId: order.id,
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
                },
            }
        })
    }

    async submitOrder(intent: OrderIntent): Promise<ExecutionResult> {
        const canonical = this.resolveCanonicalOrderMetadata(intent)
        const tokenId = intent.instrument
        const polyOrderType = mapOrderType(intent)

        // Determine price — for market orders without a price, fetch the current best
        let price = intent.limitPrice
        if (price === undefined || price <= 0) {
            const currentPrice = await this.client.getPrice(tokenId, intent.side)
            // Add a small buffer for market orders to increase fill probability
            price = intent.side === "buy"
                ? Math.min(currentPrice * 1.02, 0.99)
                : Math.max(currentPrice * 0.98, 0.01)
        }

        const response = await this.client.createOrder({
            tokenId,
            side: intent.side,
            size: intent.quantity,
            price,
            orderType: polyOrderType,
            expiration: canonical.expiration,
            negRisk: canonical.negRisk,
        })

        return {
            orderId: response.orderID,
            status: mapPostOrderStatus(response.status),
            filledQuantity: response.status === "matched" ? intent.quantity : 0,
            fillPrice: response.status === "matched" ? price : undefined,
            timestamp: Date.now(),
        }
    }

    async simulateDryRunOrder(intent: OrderIntent): Promise<ExecutionResult> {
        const canonical = this.resolveCanonicalOrderMetadata(intent)
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
            orderId: `dry-run-polymarket-${canonical.tokenId}-${Date.now()}`,
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

    async modifyOrder(orderId: string, changes: Partial<OrderIntent>): Promise<ExecutionResult> {
        const existing = await this.client.getOrder(orderId)
        const metadata = await this.resolveCanonicalMetadataForToken(
            existing.asset_id,
            existing.market,
            existing.outcome
        )
        await this.client.cancelOrder(orderId)

        const newIntent: OrderIntent = {
            instrument: existing.asset_id,
            side: existing.side.toLowerCase() as "buy" | "sell",
            quantity: changes.quantity ?? (Number(existing.original_size) - Number(existing.size_matched)),
            orderType: changes.orderType ?? "limit",
            limitPrice: changes.limitPrice ?? Number(existing.price),
            timeInForce: changes.timeInForce ?? "gtc",
            metadata,
        }

        return this.submitOrder(newIntent)
    }

    async closePosition(instrument: string, preparedIntent?: OrderIntent): Promise<ExecutionResult> {
        // instrument is the token ID — sell all held shares
        const balance = await this.client.getTokenBalance(instrument)

        if (balance <= 0) {
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

        const intent = preparedIntent ?? await this.buildCloseIntent(instrument)

        return this.submitOrder({
            ...intent,
            quantity: balance,
        })
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
        const tokenId = readNonEmptyString(metadata.tokenId) ?? intent.instrument
        const conditionId = readNonEmptyString(metadata.conditionId)
        const marketSlug = readNonEmptyString(metadata.marketSlug)
        const question = readNonEmptyString(metadata.question)
        const outcome = readNonEmptyString(metadata.outcome)

        if (!tokenId || tokenId !== intent.instrument || !conditionId || !marketSlug || !question || !outcome) {
            throw new Error("Polymarket orders require canonical tokenId, conditionId, marketSlug, question, and outcome metadata from market discovery")
        }

        return {
            tokenId,
            conditionId,
            marketSlug,
            question,
            outcome,
            category: readNonEmptyString(metadata.category),
            endDateIso: readNonEmptyString(metadata.endDateIso),
            liquidity: readNumber(metadata.liquidity),
            volume: readNumber(metadata.volume),
            negRisk: typeof metadata.negRisk === "boolean" ? metadata.negRisk : undefined,
            expiration: readNumber(metadata.expiration),
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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapOrderType(intent: OrderIntent): "GTC" | "GTD" | "FOK" | "FAK" {
    if (intent.orderType === "market") {
        return "FOK"
    }

    // Map timeInForce to Polymarket order types
    switch (intent.timeInForce) {
        case "gtc":
            return "GTC"
        case "ioc":
            return "FAK"
        case "fok":
            return "FOK"
        case "day":
            // Polymarket doesn't have a "day" equivalent, use GTC
            return "GTC"
        default:
            return "GTC"
    }
}

function mapPostOrderStatus(status: string): ExecutionResult["status"] {
    switch (status) {
        case "matched":
            return "filled"
        case "live":
            return "pending"
        default:
            return "pending"
    }
}

function mapOpenOrderStatus(order: PolymarketOpenOrder): ExecutionResult["status"] {
    const sizeMatched = Number(order.size_matched)

    switch (order.status) {
        case "matched":
            return "filled"
        case "live":
            return sizeMatched > 0 ? "partially_filled" : "pending"
        case "cancelled":
            return "cancelled"
        case "expired":
            return "expired"
        default:
            return "pending"
    }
}

function mapOpenOrderToExecutionResult(order: PolymarketOpenOrder): ExecutionResult {
    const sizeMatched = Number(order.size_matched)
    const price = Number(order.price)

    return {
        orderId: order.id,
        status: mapOpenOrderStatus(order),
        filledQuantity: sizeMatched,
        fillPrice: sizeMatched > 0 ? price : undefined,
        timestamp: Date.now(),
    }
}

function matchesMarketQuery(
    market: PolymarketMarket,
    query: string
): boolean {
    const haystack = [
        market.question,
        market.description,
        market.category,
        market.marketSlug,
        ...market.tokens.map((token) => token.outcome),
    ]
        .join(" ")
        .toLowerCase()

    return haystack.includes(query)
}

function dedupeAndRankMarkets(markets: PolymarketMarket[]): PolymarketMarket[] {
    const byConditionId = new Map<string, PolymarketMarket>()

    for (const market of markets) {
        const existing = byConditionId.get(market.conditionId)
        if (!existing || (market.liquidity ?? 0) > (existing.liquidity ?? 0)) {
            byConditionId.set(market.conditionId, market)
        }
    }

    return Array.from(byConditionId.values())
        .sort((left, right) => (right.liquidity ?? 0) - (left.liquidity ?? 0))
}

function readNonEmptyString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : undefined
}

function readNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value)
        ? value
        : undefined
}

function buildCanonicalMetadataFromCurrentPosition(position: Position): Record<string, unknown> {
    const metadata = position.metadata ?? {}

    return {
        ...metadata,
        tokenId: readNonEmptyString(metadata.tokenId) ?? position.instrument,
        conditionId: readNonEmptyString(metadata.conditionId) ?? readNonEmptyString(metadata.market),
        marketSlug: readNonEmptyString(metadata.marketSlug) ?? readNonEmptyString(metadata.slug),
        question: readNonEmptyString(metadata.question),
        outcome: readNonEmptyString(metadata.outcome),
        category: readNonEmptyString(metadata.category),
        endDateIso: readNonEmptyString(metadata.endDateIso) ?? readNonEmptyString(metadata.endDate),
        liquidity: readNumber(metadata.liquidity),
        volume: readNumber(metadata.volume),
        negRisk: typeof metadata.negRisk === "boolean" ? metadata.negRisk : undefined,
        side: "sell",
        quantity: position.quantity,
        entryPrice: position.entryPrice,
        currentPrice: position.currentPrice,
    }
}

function mapCurrentPosition(position: PolymarketCurrentPosition): Position {
    return {
        instrument: position.asset,
        side: "long",
        quantity: position.size,
        entryPrice: position.avgPrice,
        currentPrice: position.curPrice > 0 ? position.curPrice : undefined,
        unrealizedPnl: position.cashPnl,
        metadata: {
            venue: "polymarket",
            conditionId: position.conditionId,
            tokenId: position.asset,
            market: position.conditionId,
            marketSlug: position.slug,
            question: position.title,
            outcome: position.outcome,
            slug: position.slug,
            side: "buy",
            entryPrice: position.avgPrice,
            currentPrice: position.curPrice,
            redeemable: position.redeemable,
            mergeable: position.mergeable,
            endDate: position.endDate,
            endDateIso: position.endDate,
        },
    }
}

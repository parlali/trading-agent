import {
    createExecutionErrorDetail,
    formatExecutionError,
    type AccountState,
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
    PolymarketMarket,
    PolymarketOpenOrder,
    PolymarketOrderBook,
    PolymarketTrade,
} from "./polymarket-client"

export interface PolymarketMarketPrice {
    tokenId: string
    midpoint: number
    bestBid: number
    bestAsk: number
    spread: number
    executablePrice?: number
    executableSide?: "buy" | "sell"
}

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
    }>
}

export const POLYMARKET_SEARCH_MARKETS_MAX_LIVE_PRICE_TOKENS = 4
export const POLYMARKET_SEARCH_MARKETS_LIVE_PRICE_REQUEST_BUDGET =
    POLYMARKET_SEARCH_MARKETS_MAX_LIVE_PRICE_TOKENS * 2

interface PolymarketSearchMarketsLivePriceBudget {
    remainingTokens: number
    remainingRequests: number
}

export class PolymarketVenueAdapter implements VenueAdapter, PriceVerifier {
    private positionsCache: { positions: Position[]; fetchedAt: number } | null = null
    private readonly POSITIONS_CACHE_TTL = 5000
    private readonly marketPriceCacheTtlMs = 15_000
    private readonly marketPriceCache = new Map<string, { value: PolymarketMarketPrice; fetchedAt: number }>()
    private readonly inFlightMarketPriceLookups = new Map<string, Promise<PolymarketMarketPrice>>()

    constructor(private readonly client: PolymarketClient) {}

    async getPrice(tokenId: string, side: "buy" | "sell"): Promise<number> {
        return this.client.getPrice(tokenId, side)
    }

    async getMarketPrice(
        tokenId: string,
        side?: "buy" | "sell"
    ): Promise<PolymarketMarketPrice> {
        const [midpoint, spread, executablePrice] = await Promise.all([
            this.client.getMidpoint(tokenId),
            this.client.getSpread(tokenId),
            side ? this.client.getPrice(tokenId, side) : Promise.resolve(undefined),
        ])

        return {
            tokenId,
            midpoint,
            bestBid: spread.bid,
            bestAsk: spread.ask,
            spread: spread.spread,
            executablePrice,
            executableSide: side,
        }
    }

    async getOrderBook(tokenId: string): Promise<PolymarketOrderBook> {
        return await this.client.getOrderBook(tokenId)
    }

    async searchMarkets(params: {
        category?: string
        query?: string
        conditionId?: string
        limit?: number
        includeLivePrices?: boolean
        livePriceTokenLimit?: number
    }): Promise<PolymarketMarketSearchResult[]> {
        const livePriceBudget = this.createSearchMarketsLivePriceBudget(params)

        if (params.conditionId) {
            const market = await this.client.getMarket(params.conditionId)
            return [await this.buildMarketSearchResult(market, livePriceBudget)]
        }

        const limit = params.limit ?? 10
        const category = params.category?.trim().toLowerCase()
        const query = params.query?.trim().toLowerCase()

        if (!category && !query) {
            throw new Error("search_markets requires category, query, or conditionId")
        }

        const markets = category
            ? await this.client.getTopLiquidMarketsForCategory(category, limit)
            : await this.client.searchMarkets(query!, limit)
        const filtered = query && category
            ? markets.filter((market) => matchesMarketQuery(market, query))
            : markets

        return await Promise.all(
            filtered
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

        const [trades, openOrders] = await Promise.all([
            this.client.getTrades(),
            this.client.getOpenOrders(),
        ])

        const tokenIds = new Set<string>()
        for (const trade of trades) tokenIds.add(trade.asset_id)
        for (const order of openOrders) tokenIds.add(order.asset_id)

        const tokenArray = Array.from(tokenIds)
        const results = await Promise.all(
            tokenArray.map(async (tokenId) => {
                const balance = await this.client.getTokenBalance(tokenId)
                if (balance <= 0) return null

                let midPrice: number
                try {
                    midPrice = await this.client.getMidpoint(tokenId)
                } catch {
                    midPrice = 0
                }

                return { tokenId, balance, midPrice }
            })
        )

        const positions: Position[] = []

        for (const result of results.filter(Boolean)) {
            const { tokenId, balance, midPrice } = result!
            const tokenTrades = trades.filter((t) => t.asset_id === tokenId)
            const avgEntryPrice = calculateAvgEntryPrice(tokenTrades)
            const unrealizedPnl = midPrice > 0 ? (midPrice - avgEntryPrice) * balance : 0
            const latestTrade = tokenTrades[0]

            positions.push({
                instrument: tokenId,
                side: "long",
                quantity: balance,
                entryPrice: avgEntryPrice,
                currentPrice: midPrice > 0 ? midPrice : undefined,
                unrealizedPnl,
                metadata: {
                    venue: "polymarket",
                    market: latestTrade?.market,
                    outcome: latestTrade?.outcome,
                },
            })
        }

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
            expiration: intent.metadata?.expiration as number | undefined,
            negRisk: intent.metadata?.negRisk as boolean | undefined,
        })

        return {
            orderId: response.orderID,
            status: mapPostOrderStatus(response.status),
            filledQuantity: response.status === "matched" ? intent.quantity : 0,
            fillPrice: response.status === "matched" ? price : undefined,
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
        // Polymarket does not support order modification — cancel and replace
        const existing = await this.client.getOrder(orderId)
        await this.client.cancelOrder(orderId)

        const newIntent: OrderIntent = {
            instrument: existing.asset_id,
            side: existing.side.toLowerCase() as "buy" | "sell",
            quantity: changes.quantity ?? (Number(existing.original_size) - Number(existing.size_matched)),
            orderType: changes.orderType ?? "limit",
            limitPrice: changes.limitPrice ?? Number(existing.price),
            timeInForce: changes.timeInForce ?? "gtc",
        }

        return this.submitOrder(newIntent)
    }

    async closePosition(instrument: string): Promise<ExecutionResult> {
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

        let sellPrice: number
        try {
            sellPrice = await this.client.getPrice(instrument, "sell")
        } catch {
            try {
                sellPrice = await this.client.getMidpoint(instrument)
            } catch {
                sellPrice = 0.01
            }
        }
        sellPrice = Math.max(sellPrice, 0.01)

        return this.submitOrder({
            instrument,
            side: "sell",
            quantity: balance,
            orderType: "limit",
            limitPrice: sellPrice,
            timeInForce: "ioc",
        })
    }

    async getOrderStatus(orderId: string): Promise<ExecutionResult> {
        const order = await this.client.getOrder(orderId)
        return mapOpenOrderToExecutionResult(order)
    }

    async verify(intent: OrderIntent): Promise<PriceVerification> {
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
            message: proposedPrice === undefined
                ? "Captured live Polymarket prices before submission. No limit price was provided for drift comparison."
                : `Compared proposed Polymarket price ${proposedPrice} against live midpoint ${marketPrice.midpoint}.`,
            details: {
                tokenId: intent.instrument,
                executablePrice: marketPrice.executablePrice,
                executableSide: marketPrice.executableSide,
            },
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
            remainingRequests: boundedTokenLimit * 2,
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

        if (livePriceBudget.remainingTokens <= 0 || livePriceBudget.remainingRequests < 2) {
            return undefined
        }

        livePriceBudget.remainingTokens -= 1
        livePriceBudget.remainingRequests -= 2

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

        const lookup = this.getMarketPrice(tokenId)
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

function calculateAvgEntryPrice(trades: PolymarketTrade[]): number {
    // Only consider BUY trades for entry price
    const buys = trades.filter((t) => t.side === "BUY")

    if (buys.length === 0) return 0

    let totalCost = 0
    let totalSize = 0

    for (const trade of buys) {
        const size = Number(trade.size)
        const price = Number(trade.price)
        totalCost += size * price
        totalSize += size
    }

    return totalSize > 0 ? totalCost / totalSize : 0
}

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
    const originalSize = Number(order.original_size)

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

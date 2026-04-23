import { describe, expect, it, vi } from "vitest"
import type { PolymarketClient, PolymarketMarket } from "./polymarket-client.ts"
import {
    POLYMARKET_SEARCH_MARKETS_MAX_LIVE_PRICE_TOKENS,
    PolymarketVenueAdapter,
} from "./venue-adapter.ts"

function createMarket(id: string): PolymarketMarket {
    return {
        conditionId: `condition-${id}`,
        questionId: `question-${id}`,
        question: `Will it happen ${id}?`,
        description: `Test market ${id}`,
        category: "Politics",
        tokens: [
            {
                tokenId: `token-${id}-yes`,
                outcome: "Yes",
            },
            {
                tokenId: `token-${id}-no`,
                outcome: "No",
            },
        ],
        active: true,
        closed: false,
        negRisk: false,
        minimumOrderSize: 5,
        minimumTickSize: 0.01,
        liquidity: 1000,
        volume: 5000,
        endDateIso: "2026-12-31",
        marketSlug: `will-it-happen-${id}`,
    }
}

function createClient() {
    const getTopLiquidMarketsForCategory = vi.fn()
    const searchMarkets = vi.fn()
    const getMarket = vi.fn()
    const getCurrentPositions = vi.fn()
    const getOrderBook = vi.fn().mockResolvedValue({
        market: "condition-1",
        asset_id: "token-1",
        timestamp: "123456",
        hash: "hash",
        bids: [{ price: "0.51", size: "10" }],
        asks: [{ price: "0.53", size: "10" }],
        min_order_size: "1",
        tick_size: "0.01",
        neg_risk: false,
        last_trade_price: "0.52",
    })
    const getPrice = vi.fn()
    const getMarketBySlug = vi.fn()
    const getTokenBalance = vi.fn()
    const createOrder = vi.fn()
    const getOrder = vi.fn()
    const cancelOrder = vi.fn()

    return {
        client: {
            getTopLiquidMarketsForCategory,
            searchMarkets,
            getMarket,
            getCurrentPositions,
            getOrderBook,
            getPrice,
            getMarketBySlug,
            getTokenBalance,
            createOrder,
            getOrder,
            cancelOrder,
        } as unknown as PolymarketClient,
        getTopLiquidMarketsForCategory,
        searchMarkets,
        getMarket,
        getCurrentPositions,
        getOrderBook,
        getPrice,
        getMarketBySlug,
        getTokenBalance,
        createOrder,
        getOrder,
        cancelOrder,
    }
}

describe("PolymarketVenueAdapter.searchMarkets", () => {
    it("uses Gamma category discovery without default live price hydration", async () => {
        const client = createClient()
        const market = createMarket("1")
        client.getTopLiquidMarketsForCategory.mockResolvedValue([market])

        const venue = new PolymarketVenueAdapter(client.client)
        const results = await venue.searchMarkets({
            category: "politics",
            limit: 5,
        })

        expect(client.getTopLiquidMarketsForCategory).toHaveBeenCalledWith("politics", 5)
        expect(results).toHaveLength(1)
        expect(results[0]).toMatchObject({
            conditionId: market.conditionId,
            category: market.category,
            tokens: [
                {
                    tokenId: "token-1-yes",
                    outcome: "Yes",
                },
                {
                    tokenId: "token-1-no",
                    outcome: "No",
                },
            ],
        })
        expect(client.getOrderBook).not.toHaveBeenCalled()
    })

    it("uses Gamma public search when only query text is provided", async () => {
        const client = createClient()
        const market = createMarket("1")
        client.searchMarkets.mockResolvedValue([market])

        const venue = new PolymarketVenueAdapter(client.client)
        await venue.searchMarkets({
            query: "trump",
            limit: 3,
        })

        expect(client.searchMarkets).toHaveBeenCalledWith("trump", 3)
    })

    it("uses direct market slug lookup", async () => {
        const client = createClient()
        const market = createMarket("1")
        client.getMarketBySlug.mockResolvedValue(market)

        const venue = new PolymarketVenueAdapter(client.client)
        const result = await venue.searchMarkets({
            marketSlug: "will-it-happen-1",
        })

        expect(client.getMarketBySlug).toHaveBeenCalledWith("will-it-happen-1")
        expect(result[0]?.marketSlug).toBe("will-it-happen-1")
    })

    it("keeps query results when category plus query is provided", async () => {
        const client = createClient()
        const market = createMarket("dhs")
        client.searchMarkets.mockResolvedValue([market])
        client.getTopLiquidMarketsForCategory.mockResolvedValue([])

        const venue = new PolymarketVenueAdapter(client.client)
        const result = await venue.searchMarkets({
            category: "politics",
            query: "How long will the DHS shutdown last?",
            limit: 5,
        })

        expect(client.searchMarkets).toHaveBeenCalledWith("how long will the dhs shutdown last?", 5)
        expect(result).toHaveLength(1)
    })

    it("keeps concurrent live enrichment within the bounded request envelope", async () => {
        const client = createClient()
        const markets = [
            createMarket("1"),
            createMarket("2"),
            createMarket("3"),
        ]
        client.getTopLiquidMarketsForCategory.mockResolvedValue(markets)

        const venue = new PolymarketVenueAdapter(client.client)
        const params = {
            category: "politics",
            limit: 3,
            includeLivePrices: true,
            livePriceTokenLimit: POLYMARKET_SEARCH_MARKETS_MAX_LIVE_PRICE_TOKENS,
        } as const

        const [first, second] = await Promise.all([
            venue.searchMarkets(params),
            venue.searchMarkets(params),
        ])

        expect(client.getOrderBook).toHaveBeenCalledTimes(
            POLYMARKET_SEARCH_MARKETS_MAX_LIVE_PRICE_TOKENS
        )
        expect(countEnrichedTokens(first)).toBe(POLYMARKET_SEARCH_MARKETS_MAX_LIVE_PRICE_TOKENS)
        expect(countEnrichedTokens(second)).toBe(POLYMARKET_SEARCH_MARKETS_MAX_LIVE_PRICE_TOKENS)
        expect(first.flatMap((market) => market.tokens).find((token) => token.executionCost !== undefined)?.executionCost?.metrics.instrument)
            .toBeDefined()

        await venue.searchMarkets({
            ...params,
            limit: 2,
        })

        expect(client.getOrderBook).toHaveBeenCalledTimes(
            POLYMARKET_SEARCH_MARKETS_MAX_LIVE_PRICE_TOKENS
        )
    })
})

describe("PolymarketVenueAdapter.simulateDryRunOrder", () => {
    it("requires canonical market identity and returns a token-bound simulated fill", async () => {
        const client = createClient()
        const venue = new PolymarketVenueAdapter(client.client)

        const result = await venue.simulateDryRunOrder({
            instrument: "token-1-yes",
            side: "buy",
            quantity: 10,
            orderType: "limit",
            limitPrice: 0.52,
            timeInForce: "gtc",
            metadata: {
                tokenId: "token-1-yes",
                conditionId: "condition-1",
                marketSlug: "will-it-happen-1",
                question: "Will it happen 1?",
                outcome: "Yes",
            },
        })

        expect(result).toMatchObject({
            status: "filled",
            filledQuantity: 10,
            fillPrice: 0.52,
        })
        expect(result.orderId).toContain("dry-run-polymarket-token-1-yes")
    })

    it("fails closed when canonical metadata is missing", async () => {
        const client = createClient()
        const venue = new PolymarketVenueAdapter(client.client)

        await expect(venue.simulateDryRunOrder({
            instrument: "condition-1",
            side: "buy",
            quantity: 10,
            orderType: "limit",
            limitPrice: 0.52,
            timeInForce: "gtc",
        })).rejects.toThrow("canonical tokenId")
    })
})

describe("PolymarketVenueAdapter.getMarketPrice", () => {
    it("derives prices from the same top-of-book data as getOrderBook", async () => {
        const client = createClient()
        client.getOrderBook.mockResolvedValue({
            market: "condition-consistency",
            asset_id: "token-consistency",
            timestamp: "123456",
            hash: "hash",
            bids: [
                { price: "0.54", size: "5" },
                { price: "0.53", size: "9" },
            ],
            asks: [
                { price: "0.57", size: "3" },
                { price: "0.58", size: "8" },
            ],
            min_order_size: "1",
            tick_size: "0.01",
            neg_risk: false,
            last_trade_price: "0.55",
        })

        const venue = new PolymarketVenueAdapter(client.client)
        const marketPrice = await venue.getMarketPrice("token-consistency", "buy")
        const orderBook = await venue.getOrderBook("token-consistency")

        const topBid = Number(orderBook.bids[0]?.price ?? "0")
        const topAsk = Number(orderBook.asks[0]?.price ?? "0")

        expect(marketPrice.bestBid).toBe(topBid)
        expect(marketPrice.bestAsk).toBe(topAsk)
        expect(marketPrice.midpoint).toBe((topBid + topAsk) / 2)
        expect(marketPrice.spread).toBe(topAsk - topBid)
        expect(marketPrice.executablePrice).toBe(topAsk)
        expect(marketPrice.liquidityWarning).toBe(false)
        expect(marketPrice.executionCost.status).toBe("normal")
        expect(marketPrice.executionCost.metrics.nativeSpreadUnit).toBe("probability")
    })

    it("flags liquidityWarning when only dust levels are present", async () => {
        const client = createClient()
        client.getOrderBook.mockResolvedValue({
            market: "condition-dust",
            asset_id: "token-dust",
            timestamp: "123456",
            hash: "hash",
            bids: [{ price: "0.41", size: "0.2" }],
            asks: [{ price: "0.59", size: "0.2" }],
            min_order_size: "1",
            tick_size: "0.01",
            neg_risk: false,
            last_trade_price: "0.5",
        })

        const venue = new PolymarketVenueAdapter(client.client)
        const marketPrice = await venue.getMarketPrice("token-dust", "sell")

        expect(marketPrice.bestBid).toBe(0.41)
        expect(marketPrice.bestAsk).toBe(0.59)
        expect(marketPrice.executablePrice).toBe(0.41)
        expect(marketPrice.liquidityWarning).toBe(true)
        expect(marketPrice.executionCost.status).toBe("blocked")
    })
})

describe("PolymarketVenueAdapter.closePosition", () => {
    it("submits live closes with canonical provider identity from current positions", async () => {
        const client = createClient()
        client.getTokenBalance.mockResolvedValue(10)
        client.getCurrentPositions.mockResolvedValue([
            {
                asset: "token-active",
                conditionId: "condition-active",
                title: "Will it happen?",
                outcome: "Yes",
                slug: "will-it-happen",
                size: 10,
                avgPrice: 0.4,
                curPrice: 0.6,
                cashPnl: 2,
                redeemable: false,
                mergeable: false,
                endDate: "2026-12-31",
            },
        ])
        client.getPrice.mockResolvedValue(0.59)
        client.getOrderBook.mockResolvedValue({
            market: "condition-active",
            asset_id: "token-active",
            timestamp: "123456",
            hash: "hash",
            bids: [{ price: "0.58", size: "10" }],
            asks: [{ price: "0.6", size: "10" }],
            min_order_size: "1",
            tick_size: "0.01",
            neg_risk: false,
            last_trade_price: "0.59",
        })
        client.createOrder.mockResolvedValue({
            orderID: "close-order-1",
            status: "matched",
        })

        const venue = new PolymarketVenueAdapter(client.client)
        const result = await venue.closePosition("token-active")

        expect(result.status).toBe("filled")
        expect(client.createOrder).toHaveBeenCalledWith(expect.objectContaining({
            tokenId: "token-active",
            side: "sell",
            size: 10,
            price: 0.59,
        }))
    })

    it("fails closed when a live close cannot resolve canonical provider identity", async () => {
        const client = createClient()
        client.getTokenBalance.mockResolvedValue(10)
        client.getCurrentPositions.mockResolvedValue([])

        const venue = new PolymarketVenueAdapter(client.client)

        await expect(venue.closePosition("token-active")).rejects.toThrow("provider position identity")
        expect(client.createOrder).not.toHaveBeenCalled()
    })
})

describe("PolymarketVenueAdapter.modifyOrder", () => {
    it("resolves replacement identity before cancelling the existing order", async () => {
        const client = createClient()
        client.getOrder.mockResolvedValue({
            id: "order-1",
            status: "live",
            owner: "owner",
            market: "condition-1",
            asset_id: "token-1-yes",
            side: "BUY",
            original_size: "10",
            size_matched: "0",
            price: "0.5",
            outcome: "Yes",
            order_type: "GTC",
            created_at: "2026-04-12T00:00:00.000Z",
            expiration: "0",
        })
        client.getCurrentPositions.mockResolvedValue([])
        client.getMarket.mockRejectedValue(new Error("market lookup failed"))

        const venue = new PolymarketVenueAdapter(client.client)

        await expect(venue.modifyOrder("order-1", { limitPrice: 0.51 })).rejects.toThrow("market lookup failed")
        expect(client.cancelOrder).not.toHaveBeenCalled()
        expect(client.createOrder).not.toHaveBeenCalled()
    })
})

describe("PolymarketVenueAdapter.getPositions", () => {
    it("uses current positions and excludes redeemable and mergeable balances", async () => {
        const client = createClient()
        client.getCurrentPositions.mockResolvedValue([
            {
                asset: "token-active",
                conditionId: "condition-active",
                size: 64.5161,
                avgPrice: 0.3099,
                cashPnl: -9.3548,
                curPrice: 0.165,
                redeemable: false,
                mergeable: false,
                title: "Will the US acquire part of Greenland in 2026?",
                slug: "will-the-us-acquire-any-part-of-greenland-in-2026",
                outcome: "Yes",
                endDate: "2026-12-31",
            },
            {
                asset: "token-redeemable",
                conditionId: "condition-redeemable",
                size: 29.4117,
                avgPrice: 0.3399,
                cashPnl: -9.9999,
                curPrice: 0,
                redeemable: true,
                mergeable: false,
                title: "Redeemable position",
                slug: "redeemable-position",
                outcome: "Yes",
                endDate: "2026-02-11",
            },
            {
                asset: "token-mergeable",
                conditionId: "condition-mergeable",
                size: 10,
                avgPrice: 0.5,
                cashPnl: 0,
                curPrice: 0.5,
                redeemable: false,
                mergeable: true,
                title: "Mergeable position",
                slug: "mergeable-position",
                outcome: "No",
                endDate: "2026-02-11",
            },
        ])

        const venue = new PolymarketVenueAdapter(client.client)
        const positions = await venue.getPositions()

        expect(client.getCurrentPositions).toHaveBeenCalledOnce()
        expect(positions).toMatchObject([
            {
                instrument: "token-active",
                side: "long",
                quantity: 64.5161,
                entryPrice: 0.3099,
                currentPrice: 0.165,
                unrealizedPnl: -9.3548,
                metadata: {
                    venue: "polymarket",
                    market: "condition-active",
                    conditionId: "condition-active",
                    tokenId: "token-active",
                    marketSlug: "will-the-us-acquire-any-part-of-greenland-in-2026",
                    question: "Will the US acquire part of Greenland in 2026?",
                    outcome: "Yes",
                    slug: "will-the-us-acquire-any-part-of-greenland-in-2026",
                    redeemable: false,
                    mergeable: false,
                    endDate: "2026-12-31",
                },
            },
        ])
    })
})

function countEnrichedTokens(markets: Awaited<ReturnType<PolymarketVenueAdapter["searchMarkets"]>>): number {
    return markets.flatMap((market) => market.tokens).filter((token) => token.midpoint !== undefined).length
}

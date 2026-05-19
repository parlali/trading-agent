import { describe, expect, it, vi } from "vitest"
import { createExecutionError } from "@valiq-trading/core"
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

function createOrderBook(overrides: Record<string, unknown> = {}) {
    return {
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
        ...overrides,
    }
}

function createClient() {
    const getTopLiquidMarketsForCategory = vi.fn()
    const searchMarkets = vi.fn()
    const getMarket = vi.fn()
    const getCurrentPositions = vi.fn()
    const getOrderBook = vi.fn().mockResolvedValue(createOrderBook())
    const getPrice = vi.fn()
    const getMarketBySlug = vi.fn()
    const getTokenBalance = vi.fn()
    const prepareOrder = vi.fn()
    const postPreparedOrder = vi.fn()
    const createOrder = vi.fn()
    const getOrder = vi.fn()
    const getOpenOrders = vi.fn()
    const getTrades = vi.fn()
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
            prepareOrder,
            postPreparedOrder,
            createOrder,
            getOrder,
            getOpenOrders,
            getTrades,
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
        prepareOrder,
        postPreparedOrder,
        createOrder,
        getOrder,
        getOpenOrders,
        getTrades,
        cancelOrder,
    }
}

function createIdentityContext(canonicalOrderId: string, signedOrderFingerprint?: string) {
    return {
        identity: {
            canonicalOrderId,
            providerClientOrderId: canonicalOrderId,
            providerOrderAliases: [],
            submitAttemptId: "attempt",
            submitAttemptSequence: 1,
            commitOutcome: "accepted" as const,
            signedOrderFingerprint,
            venue: "polymarket",
            role: "close" as const,
            sequence: 1,
        },
    }
}

describe("PolymarketVenueAdapter.searchMarkets", () => {
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
    it("flags liquidityWarning when only dust levels are present", async () => {
        const client = createClient()
        client.getOrderBook.mockResolvedValue(createOrderBook({
            market: "condition-dust",
            asset_id: "token-dust",
            bids: [{ price: "0.41", size: "0.2" }],
            asks: [{ price: "0.59", size: "0.2" }],
            last_trade_price: "0.5",
        }))

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
        client.getTokenBalance.mockResolvedValue(15)
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
        client.getOrderBook.mockResolvedValue(createOrderBook({
            market: "condition-active",
            asset_id: "token-active",
            bids: [{ price: "0.58", size: "10" }],
            asks: [{ price: "0.6", size: "10" }],
            last_trade_price: "0.59",
        }))
        client.prepareOrder.mockImplementation(async (params: { price: number; size: number }) => ({
            orderBody: {
                order: {},
            },
            signedOrderFingerprint: "signed-fingerprint",
            signedOrderMetadata: {
                price: params.price,
                size: params.size,
                signedOrderFingerprint: "signed-fingerprint",
            },
        }))
        client.postPreparedOrder.mockResolvedValue({
            orderID: "close-order-1",
            status: "matched",
            signedOrderFingerprint: "signed-fingerprint",
        })

        const venue = new PolymarketVenueAdapter(client.client)
        const closeIntent = await venue.buildCloseIntent("token-active")
        const context = createIdentityContext("vpmc01close12345")
        await venue.prepareOrderIdentity({
            ...closeIntent,
            quantity: 10,
        }, context)
        const result = await venue.closePosition("token-active", closeIntent, context)

        expect(result.status).toBe("filled")
        expect(result.filledQuantity).toBe(10)
        expect(client.prepareOrder).toHaveBeenCalledWith(expect.objectContaining({
            tokenId: "token-active",
            canonicalOrderId: "vpmc01close12345",
            side: "sell",
            size: 10,
            price: 0.59,
        }))
        expect(client.postPreparedOrder).toHaveBeenCalled()
    })

    it("fails closed when token balance falls below the prepared close quantity", async () => {
        const client = createClient()
        client.getTokenBalance.mockResolvedValue(5)
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
        client.prepareOrder.mockImplementation(async (params: { price: number; size: number }) => ({
            orderBody: {
                order: {},
            },
            signedOrderFingerprint: "signed-fingerprint",
            signedOrderMetadata: {
                price: params.price,
                size: params.size,
                signedOrderFingerprint: "signed-fingerprint",
            },
        }))

        const venue = new PolymarketVenueAdapter(client.client)
        const closeIntent = await venue.buildCloseIntent("token-active")
        const context = createIdentityContext("vpmc01close12345")
        await venue.prepareOrderIdentity(closeIntent, context)
        const result = await venue.closePosition("token-active", closeIntent, context)

        expect(result.status).toBe("rejected")
        expect(result.errorDetail).toMatchObject({
            code: "POLYMARKET_CLOSE_BALANCE_BELOW_PREPARED_QUANTITY",
        })
        expect(client.postPreparedOrder).not.toHaveBeenCalled()
    })

    it("rejects submissions when the intent quantity differs from the prepared signed size", async () => {
        const client = createClient()
        client.prepareOrder.mockImplementation(async (params: { price: number; size: number }) => ({
            orderBody: {
                order: {},
            },
            signedOrderFingerprint: "signed-fingerprint",
            signedOrderMetadata: {
                price: params.price,
                size: params.size,
                signedOrderFingerprint: "signed-fingerprint",
            },
        }))

        const venue = new PolymarketVenueAdapter(client.client)
        const context = createIdentityContext("vpmc01close12345")
        const intent = {
            instrument: "token-active",
            side: "sell" as const,
            quantity: 10,
            orderType: "limit" as const,
            limitPrice: 0.59,
            timeInForce: "ioc" as const,
            metadata: {
                tokenId: "token-active",
                conditionId: "condition-active",
                marketSlug: "will-it-happen",
                question: "Will it happen?",
                outcome: "Yes",
            },
        }

        await venue.prepareOrderIdentity(intent, context)

        await expect(venue.submitOrder({
            ...intent,
            quantity: 15,
        }, context)).rejects.toMatchObject({
            executionError: {
                code: "PREPARED_SIGNED_ORDER_SIZE_MISMATCH",
            },
        })
        await expect(venue.submitOrder(intent, context)).rejects.toMatchObject({
            executionError: {
                code: "MISSING_PREPARED_SIGNED_ORDER",
            },
        })
        expect(client.postPreparedOrder).not.toHaveBeenCalled()
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
    it("fails closed without cancelling or replacing the existing order", async () => {
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

        const result = await venue.modifyOrder("order-1", { limitPrice: 0.51 })

        expect(result.status).toBe("rejected")
        expect(result.errorDetail?.code).toBe("POLYMARKET_MODIFY_REQUIRES_NEW_SUBMISSION")
        expect(client.cancelOrder).not.toHaveBeenCalled()
        expect(client.postPreparedOrder).not.toHaveBeenCalled()
        expect(client.createOrder).not.toHaveBeenCalled()
    })
})

describe("PolymarketVenueAdapter.recoverSubmittedOrder", () => {
    it("recovers duplicated posts only from an exact signed-order fingerprint match", async () => {
        const client = createClient()
        client.getOpenOrders.mockResolvedValue([
            createOpenOrder({
                id: "wrong-order",
                signedOrderFingerprint: "fingerprint-wrong",
            }),
            createOpenOrder({
                id: "matching-order",
                signedOrderFingerprint: "fingerprint-correct",
            }),
        ])
        client.getTrades.mockResolvedValue([])
        const venue = new PolymarketVenueAdapter(client.client)

        const recovery = await venue.recoverSubmittedOrder(
            createPolymarketIntent(),
            createIdentityContext("vpme01abcde23456", "fingerprint-correct"),
            createDuplicateOrderError("fingerprint-correct")
        )

        expect(recovery.outcome).toBe("accepted")
        expect(recovery.outcome === "accepted" ? recovery.result.orderId : undefined).toBe("matching-order")
        expect(recovery.outcome === "accepted" ? recovery.result.signedOrderFingerprint : undefined).toBe("fingerprint-correct")
    })

    it("does not recover a geometry match when the provider cannot prove the fingerprint", async () => {
        const client = createClient()
        client.getOpenOrders.mockResolvedValue([
            createOpenOrder({
                id: "geometry-only-order",
                signedOrderFingerprint: undefined,
            }),
        ])
        client.getTrades.mockResolvedValue([])
        const venue = new PolymarketVenueAdapter(client.client)

        const recovery = await venue.recoverSubmittedOrder(
            createPolymarketIntent(),
            createIdentityContext("vpme01abcde23456", "fingerprint-correct"),
            createDuplicateOrderError("fingerprint-correct")
        )

        expect(recovery).toMatchObject({
            outcome: "not_found",
            details: {
                exactOpenMatchCount: 0,
                openCandidateCount: 1,
            },
        })
    })

    it("uses recent matched activity plus provider order lookup for terminal duplicate proof", async () => {
        const client = createClient()
        client.getOpenOrders.mockResolvedValue([])
        client.getTrades.mockResolvedValue([
            createTrade({
                maker_order_id: "terminal-order",
                signedOrderFingerprint: "fingerprint-correct",
            }),
        ])
        client.getOrder.mockResolvedValue(createOpenOrder({
            id: "terminal-order",
            status: "matched",
            signedOrderFingerprint: "fingerprint-correct",
        }))
        const venue = new PolymarketVenueAdapter(client.client)

        const recovery = await venue.recoverSubmittedOrder(
            createPolymarketIntent(),
            createIdentityContext("vpme01abcde23456", "fingerprint-correct"),
            createDuplicateOrderError("fingerprint-correct")
        )

        expect(client.getOrder).toHaveBeenCalledWith("terminal-order")
        expect(recovery.outcome).toBe("accepted")
        expect(recovery.outcome === "accepted" ? recovery.result.orderId : undefined).toBe("terminal-order")
    })

    it("probes persisted signed fingerprints for retryable non-duplicate submit failures", async () => {
        const client = createClient()
        client.getOpenOrders.mockResolvedValue([
            createOpenOrder({
                id: "matching-order",
                signedOrderFingerprint: "fingerprint-correct",
            }),
        ])
        client.getTrades.mockResolvedValue([])
        const venue = new PolymarketVenueAdapter(client.client)

        const recovery = await venue.recoverSubmittedOrder(
            createPolymarketIntent(),
            createIdentityContext("vpme01abcde23456", "fingerprint-correct"),
            createRetryablePostError()
        )

        expect(client.getOpenOrders).toHaveBeenCalled()
        expect(recovery.outcome).toBe("accepted")
        expect(recovery.outcome === "accepted" ? recovery.result.orderId : undefined).toBe("matching-order")
    })

    it("dedupes a partial fill seen in both open orders and trades by provider order id", async () => {
        const client = createClient()
        client.getOpenOrders.mockResolvedValue([
            createOpenOrder({
                id: "partial-order",
                status: "live",
                size_matched: "3",
                signedOrderFingerprint: "fingerprint-correct",
            }),
        ])
        client.getTrades.mockResolvedValue([
            createTrade({
                maker_order_id: "partial-order",
                signedOrderFingerprint: "fingerprint-correct",
            }),
        ])
        const venue = new PolymarketVenueAdapter(client.client)

        const recovery = await venue.recoverSubmittedOrder(
            createPolymarketIntent(),
            createIdentityContext("vpme01abcde23456", "fingerprint-correct"),
            createDuplicateOrderError("fingerprint-correct")
        )

        expect(client.getOrder).not.toHaveBeenCalled()
        expect(recovery.outcome).toBe("accepted")
        expect(recovery.outcome === "accepted" ? recovery.result.orderId : undefined).toBe("partial-order")
        expect(recovery.outcome === "accepted" ? recovery.result.status : undefined).toBe("partially_filled")
    })

    it("refuses duplicate recovery when the persisted fingerprint differs from the provider error", async () => {
        const client = createClient()
        const venue = new PolymarketVenueAdapter(client.client)

        const recovery = await venue.recoverSubmittedOrder(
            createPolymarketIntent(),
            createIdentityContext("vpme01abcde23456", "fingerprint-persisted"),
            createDuplicateOrderError("fingerprint-provider")
        )

        expect(recovery).toMatchObject({
            outcome: "not_found",
            details: {
                persistedSignedOrderFingerprint: "fingerprint-persisted",
                signedOrderFingerprint: "fingerprint-provider",
            },
        })
        expect(client.getOpenOrders).not.toHaveBeenCalled()
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

function createPolymarketIntent() {
    return {
        instrument: "token-1-yes",
        side: "buy" as const,
        quantity: 10,
        orderType: "limit" as const,
        limitPrice: 0.52,
        timeInForce: "gtc" as const,
    }
}

function createDuplicateOrderError(signedOrderFingerprint: string): Error {
    return createExecutionError("venue", "Polymarket duplicate order", {
        code: "INVALID_ORDER_DUPLICATED",
        retryable: false,
        details: {
            signedOrderFingerprint,
        },
    })
}

function createRetryablePostError(): Error {
    return createExecutionError("venue", "Polymarket post timed out", {
        code: "NETWORK_TIMEOUT",
        retryable: true,
    })
}

function createOpenOrder(overrides: Record<string, unknown> = {}) {
    return {
        id: "order-1",
        status: "live",
        owner: "owner",
        market: "condition-1",
        asset_id: "token-1-yes",
        side: "buy",
        original_size: "10",
        size_matched: "0",
        price: "0.52",
        outcome: "Yes",
        order_type: "GTC",
        created_at: "2026-04-12T00:00:00.000Z",
        expiration: "0",
        signedOrderFingerprint: "fingerprint-correct",
        ...overrides,
    }
}

function createTrade(overrides: Record<string, unknown> = {}) {
    return {
        id: "trade-1",
        taker_order_id: "taker-order",
        market: "condition-1",
        asset_id: "token-1-yes",
        side: "buy",
        size: "10",
        price: "0.52",
        fee_rate_bps: "0",
        status: "matched",
        match_time: "2026-04-12T00:00:00.000Z",
        outcome: "Yes",
        trader_side: "maker",
        signedOrderFingerprint: "fingerprint-correct",
        ...overrides,
    }
}

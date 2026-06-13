import { describe, expect, it, vi } from "vitest"
import { createExecutionError, type OrderIntent } from "@valiq-trading/core"
import type { PolymarketClient, PolymarketMarket } from "./polymarket-client.ts"
import {
    buildPolymarketFeeMetadata,
    PolymarketVenueAdapter,
} from "./venue-adapter.ts"
import { POLYMARKET_SEARCH_MARKETS_MAX_LIVE_PRICE_TOKENS } from "./venue-adapter-market-metadata.ts"

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
    const getTrades = vi.fn().mockResolvedValue([])
    const cancelOrder = vi.fn()
    const getFeeRateBps = vi.fn()
    const getBalance = vi.fn()

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
            getFeeRateBps,
            getBalance,
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
        getFeeRateBps,
        getBalance,
    }
}

function createIdentityContext(
    canonicalOrderId: string,
    signedOrderFingerprint?: string,
    signedOrderMetadata?: Record<string, unknown>
) {
    return {
        identity: {
            canonicalOrderId,
            providerClientOrderId: canonicalOrderId,
            providerOrderAliases: [],
            submitAttemptId: "attempt",
            submitAttemptSequence: 1,
            commitOutcome: "accepted" as const,
            signedOrderFingerprint,
            signedOrderMetadata,
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

    it("rejects unsupported stop and day semantics in dry-run before pricing", async () => {
        const client = createClient()
        const venue = new PolymarketVenueAdapter(client.client)
        const context = createIdentityContext("vpmc01dryreject")

        await expect(venue.simulateDryRunOrder({
            ...createPolymarketIntent({
                orderType: "stop_limit",
                stopPrice: 0.45,
                metadata: createCanonicalOrderMetadata(),
            }),
        }, context)).rejects.toMatchObject({
            executionError: {
                code: "POLYMARKET_UNSUPPORTED_ORDER_SEMANTICS",
                retryable: false,
            },
        })
        await expect(venue.simulateDryRunOrder({
            ...createPolymarketIntent({
                timeInForce: "day",
                metadata: createCanonicalOrderMetadata(),
            }),
        }, context)).rejects.toMatchObject({
            executionError: {
                code: "POLYMARKET_UNSUPPORTED_ORDER_SEMANTICS",
                retryable: false,
            },
        })
        expect(client.getPrice).not.toHaveBeenCalled()
        expect(client.getOrderBook).not.toHaveBeenCalled()
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
            makingAmount: "10000000",
            takingAmount: "5900000",
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
            price: 0.5782,
        }))
        expect(client.postPreparedOrder).toHaveBeenCalled()
    })

    it("records partial matched FAK fills from provider post amounts", async () => {
        const client = createClient()
        client.prepareOrder.mockImplementation(async (params: { price: number; size: number }) => ({
            orderBody: {
                order: {},
            },
            signedOrderFingerprint: "signed-fingerprint",
            signedOrderMetadata: {
                price: params.price,
                size: params.size,
                feeRateBps: 0,
                signedOrderFingerprint: "signed-fingerprint",
            },
        }))
        client.postPreparedOrder.mockResolvedValue({
            orderID: "entry-order-partial",
            status: "matched",
            makingAmount: "1500000",
            takingAmount: "3000000",
            signedOrderFingerprint: "signed-fingerprint",
        })

        const venue = new PolymarketVenueAdapter(client.client)
        const intent = {
            instrument: "token-active",
            side: "buy" as const,
            quantity: 10,
            orderType: "limit" as const,
            limitPrice: 0.42,
            timeInForce: "ioc" as const,
            metadata: {
                tokenId: "token-active",
                conditionId: "condition-active",
                marketSlug: "will-it-happen",
                question: "Will it happen?",
                outcome: "Yes",
            },
        }
        const context = createIdentityContext("vpmc01entrypart")
        await venue.prepareOrderIdentity(intent, context)
        const result = await venue.submitOrder(intent, context)

        expect(result.status).toBe("partially_filled")
        expect(result.filledQuantity).toBe(3)
        expect(result.fillPrice).toBe(0.5)
        expect(result.intentUpdates?.metadata).toMatchObject({
            providerAccountingSource: "polymarket_post_order_amounts",
            providerMakingAmount: "1500000",
            providerTakingAmount: "3000000",
        })
    })

    it("maps terminal unmatched and unknown post statuses to non-pending results", async () => {
        const client = createClient()
        client.prepareOrder.mockImplementation(async (params: { price: number; size: number }) => ({
            orderBody: {
                order: {},
            },
            signedOrderFingerprint: `signed-fingerprint-${params.size}`,
            signedOrderMetadata: {
                price: params.price,
                size: params.size,
                feeRateBps: 0,
                signedOrderFingerprint: `signed-fingerprint-${params.size}`,
            },
        }))
        client.postPreparedOrder
            .mockResolvedValueOnce({
                orderID: "order-unmatched",
                status: "unmatched",
                signedOrderFingerprint: "signed-fingerprint-10",
            })
            .mockResolvedValueOnce({
                orderID: "order-unknown",
                status: "mystery-status",
                signedOrderFingerprint: "signed-fingerprint-11",
            })

        const venue = new PolymarketVenueAdapter(client.client)
        const firstIntent = createPolymarketIntent({
            quantity: 10,
            metadata: createCanonicalOrderMetadata(),
        })
        const secondIntent = createPolymarketIntent({
            quantity: 11,
            metadata: createCanonicalOrderMetadata(),
        })
        const firstContext = createIdentityContext("vpmc01unmatched1")
        const secondContext = createIdentityContext("vpmc01unknown01")

        await venue.prepareOrderIdentity(firstIntent, firstContext)
        await venue.prepareOrderIdentity(secondIntent, secondContext)

        await expect(venue.submitOrder(firstIntent, firstContext)).resolves.toMatchObject({
            orderId: "order-unmatched",
            status: "cancelled",
            filledQuantity: 0,
        })
        await expect(venue.submitOrder(secondIntent, secondContext)).resolves.toMatchObject({
            orderId: "order-unknown",
            status: "rejected",
            filledQuantity: 0,
        })
    })

    it("rejects unsupported live order semantics before provider preparation", async () => {
        const client = createClient()
        const venue = new PolymarketVenueAdapter(client.client)

        await expect(venue.prepareOrderIdentity(
            createPolymarketIntent({
                orderType: "limit",
                stopPrice: 0.45,
                metadata: createCanonicalOrderMetadata(),
            }),
            createIdentityContext("vpmc01livereject")
        )).rejects.toMatchObject({
            executionError: {
                code: "POLYMARKET_UNSUPPORTED_ORDER_SEMANTICS",
                retryable: false,
            },
        })
        expect(client.prepareOrder).not.toHaveBeenCalled()
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

describe("PolymarketVenueAdapter.cancelOrder", () => {
    it("fails commit-unknown when cancel status cannot be confirmed after provider cancel", async () => {
        const client = createClient()
        client.cancelOrder.mockResolvedValue(undefined)
        client.getOrder.mockRejectedValue(new Error("not found"))

        const venue = new PolymarketVenueAdapter(client.client)

        await expect(venue.cancelOrder("order-cancel-1")).rejects.toMatchObject({
            executionError: {
                code: "POLYMARKET_CANCEL_STATUS_UNCONFIRMED",
                retryable: true,
            },
        })
    })
})

describe("PolymarketVenueAdapter.recoverSubmittedOrder", () => {
    it("recovers duplicated posts from exact signed-order salt on open orders", async () => {
        const client = createClient()
        client.getOpenOrders.mockResolvedValue([
            createOpenOrder({
                id: "wrong-order",
                salt: "salt-wrong",
                signedOrderFingerprint: undefined,
            }),
            createOpenOrder({
                id: "matching-order",
                salt: "salt-correct",
                signedOrderFingerprint: undefined,
            }),
        ])
        client.getTrades.mockResolvedValue([])
        const venue = new PolymarketVenueAdapter(client.client)

        const recovery = await venue.recoverSubmittedOrder(
            createPolymarketIntent(),
            createIdentityContext("vpme01abcde23456", "fingerprint-correct", { salt: "salt-correct" }),
            createDuplicateOrderError("fingerprint-correct")
        )

        expect(recovery.outcome).toBe("accepted")
        expect(recovery.outcome === "accepted" ? recovery.result.orderId : undefined).toBe("matching-order")
        expect(recovery.outcome === "accepted" ? recovery.result.signedOrderFingerprint : undefined).toBe("fingerprint-correct")
        expect(recovery.outcome === "accepted" ? recovery.result.signedOrderMetadata : undefined).toMatchObject({
            salt: "salt-correct",
        })
    })

    it("does not recover a geometry match when the provider cannot prove the signed-order salt", async () => {
        const client = createClient()
        client.getOpenOrders.mockResolvedValue([
            createOpenOrder({
                id: "geometry-only-order",
                salt: undefined,
                signedOrderFingerprint: undefined,
            }),
        ])
        client.getTrades.mockResolvedValue([])
        const venue = new PolymarketVenueAdapter(client.client)

        const recovery = await venue.recoverSubmittedOrder(
            createPolymarketIntent(),
            createIdentityContext("vpme01abcde23456", "fingerprint-correct", { salt: "salt-correct" }),
            createDuplicateOrderError("fingerprint-correct")
        )

        expect(recovery).toMatchObject({
            outcome: "not_found",
            details: {
                exactOpenMatchCount: 0,
                openCandidateCount: 1,
                salt: "salt-correct",
            },
        })
    })

    it("uses recent matched activity plus provider order lookup for terminal salt proof", async () => {
        const client = createClient()
        client.getOpenOrders.mockResolvedValue([])
        client.getTrades.mockResolvedValue([
            createTrade({
                maker_order_id: "terminal-order",
                signedOrderFingerprint: undefined,
            }),
        ])
        client.getOrder.mockResolvedValue(createOpenOrder({
            id: "terminal-order",
            status: "matched",
            salt: "salt-correct",
            signedOrderFingerprint: undefined,
        }))
        const venue = new PolymarketVenueAdapter(client.client)

        const recovery = await venue.recoverSubmittedOrder(
            createPolymarketIntent(),
            createIdentityContext("vpme01abcde23456", "fingerprint-correct", { salt: "salt-correct" }),
            createDuplicateOrderError("fingerprint-correct")
        )

        expect(client.getOrder).toHaveBeenCalledWith("terminal-order")
        expect(recovery.outcome).toBe("accepted")
        expect(recovery.outcome === "accepted" ? recovery.result.orderId : undefined).toBe("terminal-order")
    })

    it("probes persisted signed salts for retryable non-duplicate submit failures", async () => {
        const client = createClient()
        client.getOpenOrders.mockResolvedValue([
            createOpenOrder({
                id: "matching-order",
                salt: "salt-correct",
                signedOrderFingerprint: undefined,
            }),
        ])
        client.getTrades.mockResolvedValue([])
        const venue = new PolymarketVenueAdapter(client.client)

        const recovery = await venue.recoverSubmittedOrder(
            createPolymarketIntent(),
            createIdentityContext("vpme01abcde23456", "fingerprint-correct", { salt: "salt-correct" }),
            createRetryablePostError()
        )

        expect(client.getOpenOrders).toHaveBeenCalled()
        expect(recovery.outcome).toBe("accepted")
        expect(recovery.outcome === "accepted" ? recovery.result.orderId : undefined).toBe("matching-order")
    })

    it("classifies unknown submit errors as commit-unknown for recovery", async () => {
        const client = createClient()
        const venue = new PolymarketVenueAdapter(client.client)

        expect(venue.classifySubmitError(new Error("socket closed after post"))).toBe("commit_unknown")
    })

    it("dedupes a partial fill seen in both open orders and trades by provider order id", async () => {
        const client = createClient()
        client.getOpenOrders.mockResolvedValue([
            createOpenOrder({
                id: "partial-order",
                status: "live",
                size_matched: "3",
                salt: "salt-correct",
                signedOrderFingerprint: undefined,
            }),
        ])
        client.getTrades.mockResolvedValue([
            createTrade({
                maker_order_id: "partial-order",
                signedOrderFingerprint: undefined,
            }),
        ])
        const venue = new PolymarketVenueAdapter(client.client)

        const recovery = await venue.recoverSubmittedOrder(
            createPolymarketIntent(),
            createIdentityContext("vpme01abcde23456", "fingerprint-correct", { salt: "salt-correct" }),
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
                initialValue: 20,
                currentValue: 10.6451565,
                cashPnl: -9.3548,
                totalBought: 64.5161,
                realizedPnl: 1.25,
                percentRealizedPnl: 6.25,
                percentPnl: -46.774,
                curPrice: 0.165,
                redeemable: false,
                mergeable: false,
                title: "Will the synthetic external market resolve yes?",
                slug: "synthetic-external-market-2026",
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
                    marketSlug: "synthetic-external-market-2026",
                    question: "Will the synthetic external market resolve yes?",
                    outcome: "Yes",
                    slug: "synthetic-external-market-2026",
                    cashPnl: -9.3548,
                    realizedPnl: 1.25,
                    percentRealizedPnl: 6.25,
                    totalBought: 64.5161,
                    redeemable: false,
                    mergeable: false,
                    endDate: "2026-12-31",
                },
            },
        ])
    })

    it("emits settlement closures for redeemable and mergeable positions while preserving their account equity value", async () => {
        const client = createClient()
        client.getBalance.mockResolvedValue(100)
        client.getCurrentPositions.mockResolvedValue([
            {
                asset: "token-active",
                conditionId: "condition-active",
                size: 10,
                avgPrice: 0.4,
                initialValue: 4,
                currentValue: 6,
                cashPnl: 2,
                totalBought: 10,
                realizedPnl: 0,
                percentRealizedPnl: 0,
                percentPnl: 50,
                curPrice: 0.6,
                redeemable: false,
                mergeable: false,
                title: "Active position",
                slug: "active-position",
                outcome: "Yes",
                endDate: "2026-12-31",
            },
            {
                asset: "token-redeemable",
                conditionId: "condition-redeemable",
                size: 5,
                avgPrice: 0.3,
                initialValue: 1.5,
                currentValue: 5,
                cashPnl: 3.5,
                totalBought: 5,
                realizedPnl: 0,
                percentRealizedPnl: 0,
                percentPnl: 233.3333,
                curPrice: 1,
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
                size: 2,
                avgPrice: 0.5,
                initialValue: 1,
                currentValue: 1,
                cashPnl: 0,
                totalBought: 2,
                realizedPnl: 0,
                percentRealizedPnl: 0,
                percentPnl: 0,
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
        const [positions, closures, accountState] = await Promise.all([
            venue.getPositions(),
            venue.getRecentPositionClosures(),
            venue.getAccountState(),
        ])

        expect(client.getCurrentPositions).toHaveBeenCalledOnce()
        expect(positions.map((position) => position.instrument)).toEqual(["token-active"])
        expect(closures).toEqual([
            expect.objectContaining({
                instrument: "token-redeemable",
                providerPositionId: "token-redeemable",
                side: "long",
                quantity: 5,
                fillPrice: 1,
                metadata: expect.objectContaining({
                    providerAccountingSource: "polymarket_position_settlement",
                    tokenId: "token-redeemable",
                    fillPnl: 3.5,
                    fee: 0,
                    feeCcy: "USDC",
                }),
            }),
            expect.objectContaining({
                instrument: "token-mergeable",
                providerPositionId: "token-mergeable",
                quantity: 2,
                fillPrice: 0.5,
                metadata: expect.objectContaining({
                    tokenId: "token-mergeable",
                    fillPnl: 0,
                }),
            }),
        ])
        expect(accountState).toMatchObject({
            balance: 100,
            equity: 112,
            marginUsed: 12,
            openPnl: 2,
        })
    })
})

describe("PolymarketVenueAdapter.getWorkingOrders", () => {
    it("maps partial live fills from data trades instead of inheriting the order limit", async () => {
        const client = createClient()
        client.getOpenOrders.mockResolvedValue([
            createOpenOrder({
                id: "partial-order",
                status: "live",
                original_size: "10",
                size_matched: "3",
                price: "0.52",
            }),
        ])
        client.getTrades.mockResolvedValue([
            createTrade({
                id: "trade-partial-1",
                maker_order_id: "partial-order",
                size: "1",
                price: "0.46",
                fee_rate_bps: "20",
            }),
            createTrade({
                id: "trade-partial-2",
                maker_order_id: "partial-order",
                size: "2",
                price: "0.49",
                fee_rate_bps: "20",
            }),
        ])

        const venue = new PolymarketVenueAdapter(client.client)
        const orders = await venue.getWorkingOrders()

        expect(client.getTrades).toHaveBeenCalledWith({ assetId: "token-1-yes" })
        expect(orders).toEqual([
            expect.objectContaining({
                orderId: "partial-order",
                status: "partially_filled",
                filledQuantity: 3,
                remainingQuantity: 7,
                limitPrice: 0.52,
                avgFillPrice: 0.48,
                metadata: expect.objectContaining({
                    providerAccountingSource: "polymarket_data_trades",
                    providerTradeIds: ["trade-partial-1", "trade-partial-2"],
                    feeCcy: "USDC",
                    providerFeeFree: false,
                }),
            }),
        ])
        expect(orders[0]?.metadata?.fee).toBeCloseTo((20 / 10_000) * (1 * 0.46 + 2 * 0.49), 12)
    })
})

function countEnrichedTokens(markets: Awaited<ReturnType<PolymarketVenueAdapter["searchMarkets"]>>): number {
    return markets.flatMap((market) => market.tokens).filter((token) => token.midpoint !== undefined).length
}

function createPolymarketIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
    return {
        ...basePolymarketIntent(),
        ...overrides,
    }
}

function basePolymarketIntent(): OrderIntent {
    return {
        instrument: "token-1-yes",
        side: "buy" as const,
        quantity: 10,
        orderType: "limit" as const,
        limitPrice: 0.52,
        timeInForce: "gtc" as const,
    }
}

function createCanonicalOrderMetadata(overrides: Record<string, unknown> = {}) {
    return {
        tokenId: "token-1-yes",
        conditionId: "condition-1",
        marketSlug: "will-it-happen-1",
        question: "Will it happen 1?",
        outcome: "Yes",
        ...overrides,
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

describe("buildPolymarketFeeMetadata", () => {
    it("marks fills explicitly fee-free only when the provider reports a zero fee rate", () => {
        expect(buildPolymarketFeeMetadata({
            feeRateBps: 0,
            size: 10,
            price: 0.42,
        })).toEqual({
            fee: 0,
            feeCcy: "USDC",
            providerFeeRateBps: 0,
            providerFeeFree: true,
            providerAccountingSource: "polymarket_fee_rate",
        })
    })

    it("computes a nonzero USDC fee from the fill size and price for fee-bearing rates", () => {
        const metadata = buildPolymarketFeeMetadata({
            feeRateBps: 20,
            size: 10,
            price: 0.42,
        })

        expect(metadata.fee).toBeCloseTo((20 / 10_000) * 0.42 * 10, 12)
        expect(metadata).toMatchObject({
            feeCcy: "USDC",
            providerFeeRateBps: 20,
            providerFeeFree: false,
            providerAccountingSource: "polymarket_fee_rate",
        })
    })

    it("uses the complement price when the fill price is above one half", () => {
        const metadata = buildPolymarketFeeMetadata({
            feeRateBps: 20,
            size: 10,
            price: 0.8,
        })

        expect(metadata.fee).toBeCloseTo((20 / 10_000) * 0.2 * 10, 12)
    })

    it("persists an explicit missing-accounting marker when the fee rate is unknown", () => {
        expect(buildPolymarketFeeMetadata({
            size: 10,
            price: 0.42,
        })).toEqual({
            providerAccountingMissing: true,
        })
    })

    it("persists an explicit missing-accounting marker when a fee-bearing fill lacks size or price", () => {
        expect(buildPolymarketFeeMetadata({
            feeRateBps: 20,
        })).toEqual({
            providerAccountingMissing: true,
            providerFeeRateBps: 20,
        })
        expect(buildPolymarketFeeMetadata({
            feeRateBps: 20,
            size: 10,
        })).toEqual({
            providerAccountingMissing: true,
            providerFeeRateBps: 20,
        })
    })
})

describe("PolymarketVenueAdapter fee accounting stamps", () => {
    function buildEntryIntent() {
        return {
            instrument: "token-active",
            side: "buy" as const,
            quantity: 10,
            orderType: "limit" as const,
            limitPrice: 0.42,
            timeInForce: "ioc" as const,
            metadata: {
                tokenId: "token-active",
                conditionId: "condition-active",
                marketSlug: "will-it-happen",
                question: "Will it happen?",
                outcome: "Yes",
            },
        }
    }

    it("stamps the signed-order fee rate into live fill accounting metadata", async () => {
        const client = createClient()
        client.prepareOrder.mockImplementation(async (params: { price: number; size: number }) => ({
            orderBody: {
                order: {},
            },
            signedOrderFingerprint: "signed-fingerprint",
            signedOrderMetadata: {
                price: params.price,
                size: params.size,
                feeRateBps: 20,
                signedOrderFingerprint: "signed-fingerprint",
            },
        }))
        client.postPreparedOrder.mockResolvedValue({
            orderID: "entry-order-1",
            status: "matched",
            makingAmount: "4200000",
            takingAmount: "10000000",
            signedOrderFingerprint: "signed-fingerprint",
        })

        const venue = new PolymarketVenueAdapter(client.client)
        const intent = buildEntryIntent()
        const context = createIdentityContext("vpmc01entry1234")
        await venue.prepareOrderIdentity(intent, context)
        const result = await venue.submitOrder(intent, context)

        expect(result.status).toBe("filled")
        expect(result.intentUpdates?.metadata).toMatchObject({
            feeCcy: "USDC",
            providerFeeRateBps: 20,
            providerFeeFree: false,
            providerAccountingSource: "polymarket_post_order_amounts",
            providerMakingAmount: "4200000",
            providerTakingAmount: "10000000",
        })
        expect(result.intentUpdates?.metadata?.fee).toBeCloseTo((20 / 10_000) * 0.42 * 10, 12)
    })

    it("stamps dry-run fills with the provider fee rate fetched from the venue", async () => {
        const client = createClient()
        client.getFeeRateBps.mockResolvedValue(0)

        const venue = new PolymarketVenueAdapter(client.client)
        const result = await venue.simulateDryRunOrder(
            buildEntryIntent(),
            createIdentityContext("vpmc01entry1234")
        )

        expect(result.status).toBe("filled")
        expect(result.intentUpdates?.metadata).toEqual({
            fee: 0,
            feeCcy: "USDC",
            providerFeeRateBps: 0,
            providerFeeFree: true,
            providerAccountingSource: "polymarket_fee_rate",
        })
    })

    it("ignores agent-supplied fee metadata and uses the provider fee rate for dry-run fills", async () => {
        const client = createClient()
        client.getFeeRateBps.mockResolvedValue(20)

        const venue = new PolymarketVenueAdapter(client.client)
        const result = await venue.simulateDryRunOrder(
            {
                ...buildEntryIntent(),
                metadata: {
                    ...buildEntryIntent().metadata,
                    feeRateBps: 0,
                },
            },
            createIdentityContext("vpmc01entry1234")
        )

        expect(result.status).toBe("filled")
        expect(result.intentUpdates?.metadata).toMatchObject({
            feeCcy: "USDC",
            providerFeeRateBps: 20,
            providerFeeFree: false,
            providerAccountingSource: "polymarket_fee_rate",
        })
        expect(result.intentUpdates?.metadata?.fee).toBeCloseTo((20 / 10_000) * 0.42 * 10, 12)
    })

    it("stamps dry-run fills with an explicit missing-accounting marker when the fee rate is unavailable", async () => {
        const client = createClient()
        client.getFeeRateBps.mockRejectedValue(new Error("fee-rate endpoint unavailable"))

        const venue = new PolymarketVenueAdapter(client.client)
        const result = await venue.simulateDryRunOrder(
            buildEntryIntent(),
            createIdentityContext("vpmc01entry1234")
        )

        expect(result.status).toBe("filled")
        expect(result.intentUpdates?.metadata).toEqual({
            providerAccountingMissing: true,
        })
    })
})

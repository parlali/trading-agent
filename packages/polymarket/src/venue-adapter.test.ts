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
    const getMidpoint = vi.fn().mockResolvedValue(0.52)
    const getSpread = vi.fn().mockResolvedValue({
        bid: 0.51,
        ask: 0.53,
        spread: 0.02,
    })
    const getPrice = vi.fn()

    return {
        client: {
            getTopLiquidMarketsForCategory,
            searchMarkets,
            getMarket,
            getCurrentPositions,
            getMidpoint,
            getSpread,
            getPrice,
        } as unknown as PolymarketClient,
        getTopLiquidMarketsForCategory,
        searchMarkets,
        getMarket,
        getCurrentPositions,
        getMidpoint,
        getSpread,
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
        expect(client.getMidpoint).not.toHaveBeenCalled()
        expect(client.getSpread).not.toHaveBeenCalled()
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

        expect(client.getMidpoint).toHaveBeenCalledTimes(
            POLYMARKET_SEARCH_MARKETS_MAX_LIVE_PRICE_TOKENS
        )
        expect(client.getSpread).toHaveBeenCalledTimes(
            POLYMARKET_SEARCH_MARKETS_MAX_LIVE_PRICE_TOKENS
        )
        expect(countEnrichedTokens(first)).toBe(POLYMARKET_SEARCH_MARKETS_MAX_LIVE_PRICE_TOKENS)
        expect(countEnrichedTokens(second)).toBe(POLYMARKET_SEARCH_MARKETS_MAX_LIVE_PRICE_TOKENS)

        await venue.searchMarkets({
            ...params,
            limit: 2,
        })

        expect(client.getMidpoint).toHaveBeenCalledTimes(
            POLYMARKET_SEARCH_MARKETS_MAX_LIVE_PRICE_TOKENS
        )
        expect(client.getSpread).toHaveBeenCalledTimes(
            POLYMARKET_SEARCH_MARKETS_MAX_LIVE_PRICE_TOKENS
        )
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
        expect(positions).toEqual([
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

import {
    readFiniteNumber,
    readTrimmedString,
    type ExecutionCostAssessment,
    type OrderIntent,
} from "@valiq-trading/core"
import type {
    PolymarketClient,
    PolymarketMarket,
} from "./polymarket-client"
import type { PolymarketMarketPrice } from "./market-price"
import {
    dedupeAndRankMarkets,
    matchesMarketQuery,
} from "./venue-adapter-mappers"

export const POLYMARKET_SEARCH_MARKETS_MAX_LIVE_PRICE_TOKENS = 4
export const POLYMARKET_SEARCH_MARKETS_LIVE_PRICE_REQUEST_BUDGET =
    POLYMARKET_SEARCH_MARKETS_MAX_LIVE_PRICE_TOKENS

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

export interface PolymarketSearchMarketsLivePriceBudget {
    remainingTokens: number
    remainingRequests: number
}

export async function resolvePolymarketSearchMarkets(
    client: PolymarketClient,
    params: {
        category?: string
        query?: string
        limit: number
    }
): Promise<PolymarketMarket[]> {
    if (params.category && params.query) {
        const [queryMarkets, categoryMarkets] = await Promise.all([
            client.searchMarkets(params.query, params.limit),
            client.getTopLiquidMarketsForCategory(params.category, params.limit),
        ])

        return dedupeAndRankMarkets([
            ...queryMarkets,
            ...categoryMarkets.filter((market) => matchesMarketQuery(market, params.query!)),
        ])
    }

    if (params.category) {
        return await client.getTopLiquidMarketsForCategory(params.category, params.limit)
    }

    return await client.searchMarkets(params.query!, params.limit)
}

export function resolvePolymarketCanonicalOrderMetadata(intent: OrderIntent): {
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

export async function buildPolymarketMarketSearchResult(args: {
    market: PolymarketMarket
    livePriceBudget?: PolymarketSearchMarketsLivePriceBudget
    maybeGetLivePrice: (
        tokenId: string,
        livePriceBudget?: PolymarketSearchMarketsLivePriceBudget
    ) => Promise<PolymarketMarketPrice | undefined>
}): Promise<PolymarketMarketSearchResult> {
    const tokens = await Promise.all(
        args.market.tokens.map(async (token) => {
            const price = await args.maybeGetLivePrice(token.tokenId, args.livePriceBudget)

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
        conditionId: args.market.conditionId,
        question: args.market.question,
        category: args.market.category,
        description: args.market.description,
        marketSlug: args.market.marketSlug,
        active: args.market.active,
        closed: args.market.closed,
        negRisk: args.market.negRisk,
        minimumOrderSize: args.market.minimumOrderSize,
        minimumTickSize: args.market.minimumTickSize,
        volume: args.market.volume,
        liquidity: args.market.liquidity,
        endDateIso: args.market.endDateIso,
        tokens,
    }
}

export function createPolymarketSearchMarketsLivePriceBudget(params: {
    includeLivePrices?: boolean
    livePriceTokenLimit?: number
    maxLivePriceTokens: number
}): PolymarketSearchMarketsLivePriceBudget | undefined {
    if (params.includeLivePrices !== true) {
        return undefined
    }

    const requestedTokenLimit = params.livePriceTokenLimit ?? params.maxLivePriceTokens
    const boundedTokenLimit = Math.min(
        requestedTokenLimit,
        params.maxLivePriceTokens
    )

    return {
        remainingTokens: boundedTokenLimit,
        remainingRequests: boundedTokenLimit,
    }
}

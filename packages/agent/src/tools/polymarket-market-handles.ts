import type { PolymarketMarketSearchResult } from "@valiq-trading/polymarket"

export const POLYMARKET_TOKEN_ID_PATTERN = /^\d{20,80}$/
export const POLYMARKET_TOKEN_HANDLE_PATTERN = /^pm_[a-z0-9]{8,16}$/

export interface PolymarketTokenHandleInput {
    tokenId?: string
    tokenHandle?: string
}

export interface PolymarketTokenHandleRecord {
    marketHandle: string
    tokenHandle: string
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
}

export type PolymarketMarketSearchResultWithHandles =
    Omit<PolymarketMarketSearchResult, "tokens"> & {
        marketHandle: string
        tokens: Array<PolymarketMarketSearchResult["tokens"][number] & {
            tokenHandle: string
        }>
    }

export class PolymarketMarketHandleRegistry {
    private readonly tokenByHandle = new Map<string, PolymarketTokenHandleRecord>()
    private readonly handleByToken = new Map<string, string>()
    private readonly marketHandleByCondition = new Map<string, string>()

    registerMarkets(
        markets: PolymarketMarketSearchResult[]
    ): PolymarketMarketSearchResultWithHandles[] {
        return markets.map((market) => {
            const marketHandle = this.resolveMarketHandle(market)
            return {
                ...market,
                marketHandle,
                tokens: market.tokens.map((token) => {
                    const tokenHandle = this.resolveTokenHandle(market, token, marketHandle)
                    return {
                        ...token,
                        tokenHandle,
                    }
                }),
            }
        })
    }

    resolveToken(input: PolymarketTokenHandleInput): PolymarketTokenHandleRecord {
        const tokenHandle = normalizeOptional(input.tokenHandle)
        if (tokenHandle) {
            const record = this.tokenByHandle.get(tokenHandle)
            if (!record) {
                throw new Error(`Unknown Polymarket tokenHandle ${tokenHandle}. Call search_markets in this run and use a returned tokenHandle.`)
            }

            return record
        }

        const tokenId = normalizeOptional(input.tokenId)
        if (!tokenId || !POLYMARKET_TOKEN_ID_PATTERN.test(tokenId)) {
            throw new Error("Invalid Polymarket tokenId. Use a canonical decimal token ID returned by search_markets or a tokenHandle returned by search_markets.")
        }

        const knownHandle = this.handleByToken.get(tokenId)
        if (knownHandle) {
            return this.tokenByHandle.get(knownHandle) ?? {
                marketHandle: "",
                tokenHandle: knownHandle,
                tokenId,
                conditionId: "",
                marketSlug: "",
                question: "",
                outcome: "",
            }
        }

        return {
            marketHandle: "",
            tokenHandle: "",
            tokenId,
            conditionId: "",
            marketSlug: "",
            question: "",
            outcome: "",
        }
    }

    private resolveMarketHandle(market: PolymarketMarketSearchResult): string {
        const existing = this.marketHandleByCondition.get(market.conditionId)
        if (existing) {
            return existing
        }

        const handle = this.uniqueHandle(`pm_${stableHash(`market:${market.conditionId}`)}`, this.marketHandleByCondition)
        this.marketHandleByCondition.set(market.conditionId, handle)
        return handle
    }

    private resolveTokenHandle(
        market: PolymarketMarketSearchResult,
        token: PolymarketMarketSearchResult["tokens"][number],
        marketHandle: string
    ): string {
        const existing = this.handleByToken.get(token.tokenId)
        if (existing) {
            return existing
        }

        const handle = this.uniqueHandle(`pm_${stableHash(`token:${market.conditionId}:${token.tokenId}`)}`, this.tokenByHandle)
        const record: PolymarketTokenHandleRecord = {
            marketHandle,
            tokenHandle: handle,
            tokenId: token.tokenId,
            conditionId: market.conditionId,
            marketSlug: market.marketSlug,
            question: market.question,
            outcome: token.outcome,
            category: market.category,
            endDateIso: market.endDateIso,
            liquidity: market.liquidity,
            volume: market.volume,
            negRisk: market.negRisk,
        }

        this.tokenByHandle.set(handle, record)
        this.handleByToken.set(token.tokenId, handle)
        return handle
    }

    private uniqueHandle(
        candidate: string,
        existing: Map<string, unknown>
    ): string {
        if (!existing.has(candidate)) {
            return candidate
        }

        let suffix = 2
        while (existing.has(`${candidate}${suffix}`)) {
            suffix++
        }

        return `${candidate}${suffix}`
    }
}

export function normalizePolymarketTokenId(value: string): string {
    const tokenId = value.trim()
    if (!POLYMARKET_TOKEN_ID_PATTERN.test(tokenId)) {
        throw new Error("Invalid Polymarket token ID")
    }

    return tokenId
}

function stableHash(value: string): string {
    let hash = 0x811c9dc5

    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193)
    }

    return (hash >>> 0).toString(36).padStart(8, "0")
}

function normalizeOptional(value: string | undefined): string | undefined {
    const normalized = value?.trim()
    return normalized && normalized.length > 0 ? normalized : undefined
}

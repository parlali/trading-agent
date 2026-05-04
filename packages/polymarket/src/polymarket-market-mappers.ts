import type { PolymarketMarket } from "./polymarket-client-types"

export interface RawMarket {
    condition_id: string
    question_id: string
    question: string
    description: string
    category: string
    tokens: Array<{ token_id: string; outcome: string }>
    active: boolean
    closed: boolean
    neg_risk: boolean
    minimum_order_size: number
    minimum_tick_size: number
    volume?: number | string
    liquidity?: number | string
    end_date_iso: string
    market_slug: string
}

export interface RawGammaEvent {
    title?: string
    description?: string
    category?: string
    tags?: Array<{
        label?: string
        slug?: string
    }>
    markets?: RawGammaMarket[]
}

export interface RawGammaMarket {
    conditionId?: string
    questionID?: string
    question?: string
    description?: string
    outcomes?: string
    clobTokenIds?: string
    active?: boolean
    closed?: boolean
    negRisk?: boolean
    orderMinSize?: number
    orderPriceMinTickSize?: number
    volume?: number | string
    liquidity?: number | string
    liquidityNum?: number
    volumeNum?: number
    endDateIso?: string
    endDate?: string
    slug?: string
}

export interface GammaSearchResponse {
    events: RawGammaEvent[]
}

export function mapRawMarket(raw: RawMarket): PolymarketMarket {
    return {
        conditionId: raw.condition_id,
        questionId: raw.question_id,
        question: raw.question,
        description: raw.description,
        category: raw.category,
        tokens: raw.tokens.map((t) => ({ tokenId: t.token_id, outcome: t.outcome })),
        active: raw.active,
        closed: raw.closed,
        negRisk: raw.neg_risk,
        minimumOrderSize: raw.minimum_order_size,
        minimumTickSize: raw.minimum_tick_size,
        volume: typeof raw.volume === "number" ? raw.volume : raw.volume ? Number(raw.volume) : undefined,
        liquidity: typeof raw.liquidity === "number" ? raw.liquidity : raw.liquidity ? Number(raw.liquidity) : undefined,
        endDateIso: raw.end_date_iso,
        marketSlug: raw.market_slug,
    }
}

export function collectGammaMarkets(
    events: RawGammaEvent[],
    fallbackCategory?: string
): PolymarketMarket[] {
    const markets = events.flatMap((event) =>
        (event.markets ?? [])
            .map((market) => mapGammaMarket(event, market, fallbackCategory))
            .filter((market): market is PolymarketMarket => market !== null)
    )

    return markets
        .filter((market) => market.active && !market.closed)
        .sort((left, right) => (right.liquidity ?? 0) - (left.liquidity ?? 0))
        .filter((market, index, all) =>
            all.findIndex((candidate) => candidate.conditionId === market.conditionId) === index
        )
}

export function mapGammaMarket(
    event: RawGammaEvent,
    market: RawGammaMarket,
    fallbackCategory?: string
): PolymarketMarket | null {
    const conditionId = asNonEmptyString(market.conditionId)
    const question = asNonEmptyString(market.question)

    if (!conditionId || !question) {
        return null
    }

    const category = resolveGammaCategory(event, fallbackCategory)
    const outcomes = parseJsonStringArray(market.outcomes)
    const tokenIds = parseJsonStringArray(market.clobTokenIds)

    return {
        conditionId,
        questionId: asNonEmptyString(market.questionID) ?? conditionId,
        question,
        description: asNonEmptyString(market.description) ?? asNonEmptyString(event.description) ?? question,
        category,
        tokens: outcomes.map((outcome, index) => ({
            tokenId: tokenIds[index] ?? "",
            outcome,
        })).filter((token) => token.tokenId.length > 0),
        active: market.active === true,
        closed: market.closed === true,
        negRisk: market.negRisk === true,
        minimumOrderSize: typeof market.orderMinSize === "number" ? market.orderMinSize : 0,
        minimumTickSize: typeof market.orderPriceMinTickSize === "number" ? market.orderPriceMinTickSize : 0.01,
        volume: coerceNumber(market.volumeNum ?? market.volume),
        liquidity: coerceNumber(market.liquidityNum ?? market.liquidity),
        endDateIso: asNonEmptyString(market.endDateIso) ?? toIsoDate(market.endDate),
        marketSlug: asNonEmptyString(market.slug) ?? conditionId,
    }
}

export function clampGammaEventLimit(limit: number): number {
    return Math.max(1, Math.min(Math.ceil(limit), 50))
}

function parseJsonStringArray(value: string | undefined): string[] {
    if (!value) {
        return []
    }

    try {
        const parsed = JSON.parse(value) as unknown
        return Array.isArray(parsed)
            ? parsed.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
            : []
    } catch {
        return []
    }
}

function resolveGammaCategory(
    event: RawGammaEvent,
    fallbackCategory?: string
): string {
    return (
        asNonEmptyString(event.category) ??
        event.tags?.find((tag) => asNonEmptyString(tag.slug) === fallbackCategory)?.label ??
        event.tags?.find((tag) => asNonEmptyString(tag.label))?.label ??
        fallbackCategory ??
        "unknown"
    )
}

function asNonEmptyString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : undefined
}

function coerceNumber(value: number | string | undefined): number | undefined {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : undefined
    }

    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number(value)
        return Number.isFinite(parsed) ? parsed : undefined
    }

    return undefined
}

function toIsoDate(value: string | undefined): string {
    if (!value) {
        return ""
    }

    const parsed = Date.parse(value)
    if (!Number.isFinite(parsed)) {
        return ""
    }

    return new Date(parsed).toISOString().slice(0, 10)
}

export function toSlugCandidate(value: string): string | null {
    const fromUrl = value.match(/polymarket\.com\/(?:event|market)\/([^/?#]+)/i)?.[1]
    const raw = fromUrl ?? value
    const normalized = raw
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")

    return normalized.length > 0 ? normalized : null
}

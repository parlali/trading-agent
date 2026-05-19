import {
    readFiniteNumber,
    readTrimmedString,
    type ExecutionResult,
    type OrderIntent,
    type Position,
} from "@valiq-trading/core"
import type {
    PolymarketCurrentPosition,
    PolymarketMarket,
    PolymarketOpenOrder,
} from "./polymarket-client"

export function mapOrderType(intent: OrderIntent): "GTC" | "GTD" | "FOK" | "FAK" {
    if (intent.orderType === "market") {
        return "FOK"
    }

    switch (intent.timeInForce) {
        case "gtc":
            return "GTC"
        case "ioc":
            return "FAK"
        case "fok":
            return "FOK"
        case "day":
            return "GTC"
        default:
            return "GTC"
    }
}

export function mapPostOrderStatus(status: string): ExecutionResult["status"] {
    switch (status) {
        case "matched":
            return "filled"
        case "live":
            return "pending"
        default:
            return "pending"
    }
}

export function mapOpenOrderStatus(order: PolymarketOpenOrder): ExecutionResult["status"] {
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

export function mapOpenOrderToExecutionResult(order: PolymarketOpenOrder): ExecutionResult {
    const sizeMatched = Number(order.size_matched)
    const price = Number(order.price)
    const signedOrderFingerprint = readPolymarketSignedOrderFingerprint(order)

    return {
        orderId: order.id,
        providerOrderId: order.id,
        providerClientOrderId: signedOrderFingerprint,
        signedOrderFingerprint,
        status: mapOpenOrderStatus(order),
        filledQuantity: sizeMatched,
        fillPrice: sizeMatched > 0 ? price : undefined,
        timestamp: Date.now(),
    }
}

export function readPolymarketSignedOrderFingerprint(order: {
    signedOrderFingerprint?: string
    signed_order_fingerprint?: string
    metadata?: Record<string, unknown>
}): string | undefined {
    return readTrimmedString(order.signedOrderFingerprint) ??
        readTrimmedString(order.signed_order_fingerprint) ??
        readTrimmedString(order.metadata?.signedOrderFingerprint)
}

export function matchesMarketQuery(
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

export function dedupeAndRankMarkets(markets: PolymarketMarket[]): PolymarketMarket[] {
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

export function buildCanonicalMetadataFromCurrentPosition(position: Position): Record<string, unknown> {
    const metadata = position.metadata ?? {}

    return {
        ...metadata,
        tokenId: readTrimmedString(metadata.tokenId) ?? position.instrument,
        conditionId: readTrimmedString(metadata.conditionId) ?? readTrimmedString(metadata.market),
        marketSlug: readTrimmedString(metadata.marketSlug) ?? readTrimmedString(metadata.slug),
        question: readTrimmedString(metadata.question),
        outcome: readTrimmedString(metadata.outcome),
        category: readTrimmedString(metadata.category),
        endDateIso: readTrimmedString(metadata.endDateIso) ?? readTrimmedString(metadata.endDate),
        liquidity: readFiniteNumber(metadata.liquidity),
        volume: readFiniteNumber(metadata.volume),
        negRisk: typeof metadata.negRisk === "boolean" ? metadata.negRisk : undefined,
        side: "sell",
        quantity: position.quantity,
        entryPrice: position.entryPrice,
        currentPrice: position.currentPrice,
    }
}

export function mapCurrentPosition(position: PolymarketCurrentPosition): Position {
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

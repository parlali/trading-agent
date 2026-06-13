import {
    readFiniteNumber,
    readTrimmedString,
    type ExecutionResult,
    type OrderIntent,
    type Position,
    type ProviderPositionClosure,
} from "@valiq-trading/core"
import type {
    PolymarketCurrentPosition,
    PolymarketMarket,
    PolymarketOpenOrder,
} from "./polymarket-client"
import { mapPolymarketProviderOrderType } from "./order-semantics"

export function mapOrderType(intent: OrderIntent): "GTC" | "GTD" | "FOK" | "FAK" {
    return mapPolymarketProviderOrderType(intent)
}

export function mapPostOrderStatus(status: string): ExecutionResult["status"] {
    switch (status) {
        case "matched":
            return "filled"
        case "live":
            return "pending"
        case "unmatched":
        case "cancelled":
        case "canceled":
            return "cancelled"
        case "expired":
            return "expired"
        case "rejected":
        case "failed":
            return "rejected"
        default:
            return "rejected"
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
        case "rejected":
        case "failed":
            return "rejected"
        default:
            return "rejected"
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

export function readPolymarketOrderSalt(order: {
    salt?: string
    order?: { salt?: string }
    metadata?: Record<string, unknown>
}): string | undefined {
    return readTrimmedString(order.salt) ??
        readTrimmedString(order.order?.salt) ??
        readTrimmedString(order.metadata?.salt)
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
            initialValue: position.initialValue,
            currentValue: position.currentValue,
            cashPnl: position.cashPnl,
            totalBought: position.totalBought,
            realizedPnl: position.realizedPnl,
            percentRealizedPnl: position.percentRealizedPnl,
            percentPnl: position.percentPnl,
            redeemable: position.redeemable,
            mergeable: position.mergeable,
            endDate: position.endDate,
            endDateIso: position.endDate,
        },
    }
}

export function mapSettlementPositionClosure(
    position: PolymarketCurrentPosition,
    closedAt: number = Date.now()
): ProviderPositionClosure | undefined {
    if (position.size <= 0 || (!position.redeemable && !position.mergeable)) {
        return undefined
    }

    const fillPrice = resolveSettlementFillPrice(position)
    const fillPnl = Number.isFinite(position.cashPnl)
        ? position.cashPnl
        : (fillPrice - position.avgPrice) * position.size

    return {
        instrument: position.asset,
        providerPositionId: position.asset,
        side: "long",
        quantity: position.size,
        fillPrice,
        closedAt,
        metadata: {
            providerAccountingSource: "polymarket_position_settlement",
            providerPositionId: position.asset,
            tokenId: position.asset,
            asset: position.asset,
            conditionId: position.conditionId,
            market: position.conditionId,
            marketSlug: position.slug,
            question: position.title,
            outcome: position.outcome,
            redeemable: position.redeemable,
            mergeable: position.mergeable,
            endDate: position.endDate,
            endDateIso: position.endDate,
            avgPrice: position.avgPrice,
            currentValue: position.currentValue,
            initialValue: position.initialValue,
            cashPnl: position.cashPnl,
            realizedPnl: position.realizedPnl,
            fillPnl,
            settlementPrice: fillPrice,
            fee: 0,
            feeCcy: "USDC",
        },
    }
}

function resolveSettlementFillPrice(position: PolymarketCurrentPosition): number {
    if (position.size > 0 && Number.isFinite(position.currentValue) && position.currentValue >= 0) {
        return roundPolymarketPrice(position.currentValue / position.size)
    }

    if (Number.isFinite(position.curPrice) && position.curPrice >= 0) {
        return roundPolymarketPrice(position.curPrice)
    }

    if (position.size > 0 && Number.isFinite(position.cashPnl) && Number.isFinite(position.avgPrice)) {
        return roundPolymarketPrice(Math.max(position.avgPrice + position.cashPnl / position.size, 0))
    }

    return 0
}

function roundPolymarketPrice(price: number): number {
    return Math.round(price * 1_000_000) / 1_000_000
}

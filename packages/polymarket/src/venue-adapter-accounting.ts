import {
    readFiniteNumber,
    readTrimmedString,
    type OrderIntent,
} from "@valiq-trading/core"
import type {
    PolymarketClient,
    PolymarketTrade,
} from "./polymarket-client"
import { AMOUNT_MULTIPLIER } from "./polymarket-order-signing"

const POLYMARKET_QUANTITY_EPSILON = 1e-9

export interface PolymarketFillSummary {
    filledQuantity: number
    fillPrice?: number
    metadata: Record<string, unknown>
}

export function mergePolymarketRecoveryOrderIds(orderIds: Array<string | undefined>): string[] {
    const ids = new Set<string>()

    for (const orderId of orderIds) {
        const normalized = readTrimmedString(orderId)
        if (normalized) {
            ids.add(normalized)
        }
    }

    return Array.from(ids).sort((left, right) => left.localeCompare(right))
}

export function resolvePreparedSignedOrderSize(metadata: Record<string, unknown>): number | undefined {
    const explicitSize = readFiniteNumber(metadata.size)
    if (explicitSize !== undefined) {
        return explicitSize
    }

    const side = readTrimmedString(metadata.side)
    const rawSize = side === "sell"
        ? readFiniteNumber(metadata.makerAmount)
        : side === "buy"
            ? readFiniteNumber(metadata.takerAmount)
            : undefined

    return rawSize !== undefined
        ? rawSize / AMOUNT_MULTIPLIER
        : undefined
}

export function resolvePostOrderFillSummary(args: {
    response: Awaited<ReturnType<PolymarketClient["postPreparedOrder"]>>
    side: "buy" | "sell"
    trades: PolymarketTrade[]
}): PolymarketFillSummary | undefined {
    const tradeSummary = summarizePolymarketTradesForOrder(args.response.orderID, args.trades)
    if (tradeSummary) {
        return tradeSummary
    }

    const makingAmount = readProviderNumber(args.response.makingAmount)
    const takingAmount = readProviderNumber(args.response.takingAmount)
    if (makingAmount === undefined || takingAmount === undefined || makingAmount <= 0 || takingAmount <= 0) {
        return undefined
    }

    const tokenAmount = args.side === "sell" ? makingAmount : takingAmount
    const usdcAmount = args.side === "sell" ? takingAmount : makingAmount
    const filledQuantity = tokenAmount / AMOUNT_MULTIPLIER
    const fillPrice = usdcAmount / tokenAmount
    if (!Number.isFinite(filledQuantity) || filledQuantity <= 0 || !Number.isFinite(fillPrice) || fillPrice < 0) {
        return undefined
    }

    return {
        filledQuantity,
        fillPrice,
        metadata: {
            providerAccountingSource: "polymarket_post_order_amounts",
            providerMakingAmount: args.response.makingAmount,
            providerTakingAmount: args.response.takingAmount,
        },
    }
}

export function buildPolymarketFeeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
    const feeRateBps = readFiniteNumber(metadata.feeRateBps)
    if (feeRateBps === undefined || feeRateBps < 0) {
        return {
            providerAccountingMissing: true,
        }
    }

    if (feeRateBps === 0) {
        return {
            fee: 0,
            feeCcy: "USDC",
            providerFeeRateBps: 0,
            providerFeeFree: true,
            providerAccountingSource: "polymarket_fee_rate",
        }
    }

    const size = resolvePreparedSignedOrderSize(metadata)
    const price = readFiniteNumber(metadata.price)
    if (size === undefined || size <= 0 || price === undefined || price <= 0 || price >= 1) {
        return {
            providerAccountingMissing: true,
            providerFeeRateBps: feeRateBps,
        }
    }

    const fee = calculatePolymarketFeeAmount(size, price, feeRateBps)

    return {
        fee,
        feeCcy: "USDC",
        providerFeeRateBps: feeRateBps,
        providerFeeFree: false,
        providerAccountingSource: "polymarket_fee_rate",
    }
}

export function matchesPolymarketRecoveryTradeGeometry(trade: PolymarketTrade, intent: OrderIntent): boolean {
    if (trade.asset_id !== intent.instrument) {
        return false
    }

    if (trade.side.toLowerCase() !== intent.side) {
        return false
    }

    const price = readProviderNumber(trade.price)
    if (intent.limitPrice !== undefined && (price === undefined || Math.abs(price - intent.limitPrice) > 1e-9)) {
        return false
    }

    const size = readProviderNumber(trade.size)
    return size !== undefined && size > 0 && size <= intent.quantity + POLYMARKET_QUANTITY_EPSILON
}

export function quantitiesMatch(left: number, right: number): boolean {
    return Math.abs(left - right) <= POLYMARKET_QUANTITY_EPSILON
}

export function readPolymarketTradeOrderId(trade: PolymarketTrade): string | undefined {
    return readTrimmedString(trade.maker_order_id) ?? readTrimmedString(trade.taker_order_id)
}

export function readRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined
}

export function summarizePolymarketTradesForOrder(
    orderId: string,
    trades: PolymarketTrade[]
): PolymarketFillSummary | undefined {
    const matches = trades.filter((trade) =>
        readTrimmedString(trade.maker_order_id) === orderId ||
        readTrimmedString(trade.taker_order_id) === orderId
    )
    if (matches.length === 0) {
        return undefined
    }

    let filledQuantity = 0
    let notional = 0
    let fee = 0
    let feeKnown = true
    const tradeIds: string[] = []

    for (const trade of matches) {
        const size = readProviderNumber(trade.size)
        const price = readProviderNumber(trade.price)
        const feeRateBps = readProviderNumber(trade.fee_rate_bps)
        if (size === undefined || size <= 0 || price === undefined || price < 0) {
            continue
        }

        filledQuantity += size
        notional += size * price
        tradeIds.push(trade.id)
        if (feeRateBps === undefined || feeRateBps < 0) {
            feeKnown = false
        } else {
            fee += calculatePolymarketFeeAmount(size, price, feeRateBps)
        }
    }

    if (filledQuantity <= 0) {
        return undefined
    }

    return {
        filledQuantity,
        fillPrice: notional / filledQuantity,
        metadata: {
            providerAccountingSource: "polymarket_data_trades",
            providerTradeIds: tradeIds,
            ...(feeKnown ? {
                fee,
                feeCcy: "USDC",
                providerFeeFree: fee === 0,
            } : {
                providerAccountingMissing: true,
                providerAccountingMissingReason: "polymarket_trade_fee_rate_missing",
            }),
        },
    }
}

function calculatePolymarketFeeAmount(size: number, price: number, feeRateBps: number): number {
    return (feeRateBps / 10_000) * Math.min(price, 1 - price) * size
}

function readProviderNumber(value: unknown): number | undefined {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : undefined
    }

    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value)
        return Number.isFinite(parsed) ? parsed : undefined
    }

    return undefined
}

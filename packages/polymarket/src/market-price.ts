import {
    createExecutionError,
    type ExecutionCostAssessment,
    type ExecutionCostSnapshot,
    type ExecutionCostTracker,
} from "@valiq-trading/core"
import type { PolymarketClient } from "./polymarket-client"

export interface PolymarketMarketPrice {
    tokenId: string
    midpoint: number
    bestBid: number
    bestAsk: number
    spread: number
    executablePrice?: number
    executableSide?: "buy" | "sell"
    liquidityWarning?: boolean
    minimumOrderSize?: number
    lastTradePrice?: number
    executionCost: ExecutionCostAssessment
}

export async function getPolymarketMarketPrice(args: {
    client: PolymarketClient
    executionCostTracker: ExecutionCostTracker
    tokenId: string
    side?: "buy" | "sell"
    warmupSampleCount?: number
}): Promise<PolymarketMarketPrice> {
    const current = await fetchRawPolymarketMarketPrice(args.client, args.tokenId, args.side)
    const warmupSampleCount = Math.max(args.warmupSampleCount ?? 3, 1)
    const snapshots = args.executionCostTracker.needsWarmup(buildPolymarketExecutionCostSnapshot(current))
        ? await collectPolymarketExecutionCostSnapshots(
            args.client,
            args.tokenId,
            current,
            warmupSampleCount
        )
        : [buildPolymarketExecutionCostSnapshot(current)]
    const executionCost = args.executionCostTracker.assessSnapshots(snapshots)

    return {
        ...current,
        executionCost,
    }
}

interface PolymarketRawMarketPrice {
    tokenId: string
    midpoint: number
    bestBid: number
    bestAsk: number
    spread: number
    executablePrice?: number
    executableSide?: "buy" | "sell"
    liquidityWarning?: boolean
    minimumOrderSize?: number
    lastTradePrice?: number
}

async function fetchRawPolymarketMarketPrice(
    client: PolymarketClient,
    tokenId: string,
    side?: "buy" | "sell"
): Promise<PolymarketRawMarketPrice> {
    const orderBook = await client.getOrderBook(tokenId)
    const minimumOrderSize = parseOptionalNumber(orderBook.min_order_size)
    const minimumVisibleSize = minimumOrderSize !== undefined && minimumOrderSize > 0
        ? minimumOrderSize
        : 0
    const lastTradePrice = parseOptionalNumber(orderBook.last_trade_price)

    const sizedBid = selectTopOfBookLevel(orderBook.bids, "bid", minimumVisibleSize)
    const sizedAsk = selectTopOfBookLevel(orderBook.asks, "ask", minimumVisibleSize)
    const rawBid = selectTopOfBookLevel(orderBook.bids, "bid", 0)
    const rawAsk = selectTopOfBookLevel(orderBook.asks, "ask", 0)
    const liquidityWarning = sizedBid === undefined || sizedAsk === undefined

    let bestBid = sizedBid?.price ?? rawBid?.price
    let bestAsk = sizedAsk?.price ?? rawAsk?.price

    if ((bestBid === undefined || bestAsk === undefined) && lastTradePrice !== undefined) {
        bestBid = bestBid ?? lastTradePrice
        bestAsk = bestAsk ?? lastTradePrice
    }

    if (bestBid === undefined || bestAsk === undefined) {
        throw createExecutionError(
            "venue",
            `Polymarket order book returned no usable top-of-book levels for token ${tokenId}`,
            {
                code: "EMPTY_ORDER_BOOK",
                retryable: false,
                details: {
                    tokenId,
                    minimumOrderSize,
                    bidLevels: orderBook.bids.length,
                    askLevels: orderBook.asks.length,
                    hasLastTradePrice: lastTradePrice !== undefined,
                },
            }
        )
    }

    const midpoint = (bestBid + bestAsk) / 2
    const spread = Math.max(bestAsk - bestBid, 0)
    const executablePrice = side === "buy"
        ? bestAsk
        : side === "sell"
            ? bestBid
            : undefined

    return {
        tokenId,
        midpoint,
        bestBid,
        bestAsk,
        spread,
        executablePrice,
        executableSide: side,
        liquidityWarning,
        minimumOrderSize,
        lastTradePrice,
    }
}

async function collectPolymarketExecutionCostSnapshots(
    client: PolymarketClient,
    tokenId: string,
    current: PolymarketRawMarketPrice,
    sampleCount: number
): Promise<ExecutionCostSnapshot[]> {
    const snapshots = [buildPolymarketExecutionCostSnapshot(current)]
    while (snapshots.length < sampleCount) {
        snapshots.push(buildPolymarketExecutionCostSnapshot(
            await fetchRawPolymarketMarketPrice(client, tokenId)
        ))
    }
    return snapshots
}

function buildPolymarketExecutionCostSnapshot(
    marketPrice: PolymarketRawMarketPrice
): ExecutionCostSnapshot {
    return {
        app: "polymarket",
        instrument: marketPrice.tokenId,
        instrumentClass: "prediction_market",
        capturedAt: Date.now(),
        bestBid: marketPrice.bestBid,
        bestAsk: marketPrice.bestAsk,
        midpoint: marketPrice.midpoint,
        referencePrice: marketPrice.midpoint,
        absoluteSpread: marketPrice.spread,
        nativeSpread: marketPrice.spread,
        nativeSpreadUnit: "probability",
        liquidityWarning: marketPrice.liquidityWarning,
    }
}

function parseOptionalNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value
    }

    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number(value)
        if (Number.isFinite(parsed)) {
            return parsed
        }
    }

    return undefined
}

function selectTopOfBookLevel(
    levels: Array<{ price: string; size: string }>,
    side: "bid" | "ask",
    minimumSize: number
): { price: number; size: number } | undefined {
    const valid = levels
        .map((level) => ({
            price: Number(level.price),
            size: Number(level.size),
        }))
        .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size) && level.size > 0)
        .filter((level) => level.size >= minimumSize)

    if (valid.length === 0) {
        return undefined
    }

    return side === "bid"
        ? valid.reduce((best, level) => (level.price > best.price ? level : best), valid[0]!)
        : valid.reduce((best, level) => (level.price < best.price ? level : best), valid[0]!)
}

import {
    ExecutionCostTracker,
    type ExecutionCostAssessment,
    type ExecutionCostSnapshot,
} from "@valiq-trading/core"
import { OKXClient } from "./okx-client"

export interface OKXMarketPrice {
    symbol: string
    markPrice: number
    lastPrice: number
    bestBid: number
    bestAsk: number
    spread: number
    fundingRate?: number
    nextFundingTime?: number
    executionCost: ExecutionCostAssessment
}

type RawOKXMarketPrice = Omit<OKXMarketPrice, "executionCost">

export async function readOKXMarketPrice(args: {
    client: OKXClient
    executionCostTracker: ExecutionCostTracker
    symbol: string
}): Promise<OKXMarketPrice> {
    const current = await fetchRawMarketPrice(args.client, args.symbol)
    const initialSnapshot = buildExecutionCostSnapshot(current)
    const snapshots = args.executionCostTracker.needsWarmup(initialSnapshot)
        ? await collectMarketPriceSnapshots(args.client, args.symbol, current, 3)
        : [initialSnapshot]
    const executionCost = args.executionCostTracker.assessSnapshots(snapshots)

    return {
        ...current,
        executionCost,
    }
}

async function fetchRawMarketPrice(
    client: OKXClient,
    symbol: string
): Promise<RawOKXMarketPrice> {
    const [ticker, mark, funding] = await Promise.all([
        client.getTicker(symbol),
        client.getMarkPrice(symbol),
        client.getFundingRate(symbol).catch(async () => {
            const history = await client.getFundingRateHistory(symbol, 1)
            return history[0]
        }),
    ])

    const bestBid = Number(ticker.bidPx)
    const bestAsk = Number(ticker.askPx)

    return {
        symbol,
        markPrice: Number(mark.markPx),
        lastPrice: Number(ticker.last),
        bestBid,
        bestAsk,
        spread: Math.max(bestAsk - bestBid, 0),
        fundingRate: funding?.fundingRate !== undefined ? Number(funding.fundingRate) : undefined,
        nextFundingTime: funding?.nextFundingTime !== undefined ? Number(funding.nextFundingTime) : undefined,
    }
}

async function collectMarketPriceSnapshots(
    client: OKXClient,
    symbol: string,
    current: RawOKXMarketPrice,
    sampleCount: number
): Promise<ExecutionCostSnapshot[]> {
    const snapshots = [buildExecutionCostSnapshot(current)]
    while (snapshots.length < sampleCount) {
        snapshots.push(buildExecutionCostSnapshot(
            await fetchRawMarketPrice(client, symbol)
        ))
    }
    return snapshots
}

function buildExecutionCostSnapshot(
    marketPrice: RawOKXMarketPrice
): ExecutionCostSnapshot {
    const midpoint = marketPrice.bestBid > 0 && marketPrice.bestAsk > 0
        ? (marketPrice.bestBid + marketPrice.bestAsk) / 2
        : marketPrice.markPrice

    return {
        app: "okx-swap",
        instrument: marketPrice.symbol,
        instrumentClass: "perpetual_swap",
        capturedAt: Date.now(),
        bestBid: marketPrice.bestBid,
        bestAsk: marketPrice.bestAsk,
        midpoint,
        referencePrice: midpoint > 0 ? midpoint : marketPrice.markPrice,
        absoluteSpread: marketPrice.spread,
        nativeSpread: marketPrice.spread,
        nativeSpreadUnit: "price",
    }
}

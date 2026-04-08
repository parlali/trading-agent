import {
    createExecutionErrorDetail,
    formatExecutionError,
    type AccountState,
    type ExecutionResult,
    type OrderIntent,
    type Position,
    type VenueAdapter,
    type WorkingOrder,
} from "@valiq-trading/core"
import type { PolymarketClient, PolymarketOpenOrder, PolymarketTrade } from "./polymarket-client"

export class PolymarketVenueAdapter implements VenueAdapter {
    private positionsCache: { positions: Position[]; fetchedAt: number } | null = null
    private readonly POSITIONS_CACHE_TTL = 5000

    constructor(private readonly client: PolymarketClient) {}

    async getPrice(tokenId: string, side: "buy" | "sell"): Promise<number> {
        return this.client.getPrice(tokenId, side)
    }

    async getPositions(): Promise<Position[]> {
        if (
            this.positionsCache &&
            Date.now() - this.positionsCache.fetchedAt < this.POSITIONS_CACHE_TTL
        ) {
            return this.positionsCache.positions
        }

        const [trades, openOrders] = await Promise.all([
            this.client.getTrades(),
            this.client.getOpenOrders(),
        ])

        const tokenIds = new Set<string>()
        for (const trade of trades) tokenIds.add(trade.asset_id)
        for (const order of openOrders) tokenIds.add(order.asset_id)

        const tokenArray = Array.from(tokenIds)
        const results = await Promise.all(
            tokenArray.map(async (tokenId) => {
                const balance = await this.client.getTokenBalance(tokenId)
                if (balance <= 0) return null

                let midPrice: number
                try {
                    midPrice = await this.client.getMidpoint(tokenId)
                } catch {
                    midPrice = 0
                }

                return { tokenId, balance, midPrice }
            })
        )

        const positions: Position[] = []

        for (const result of results.filter(Boolean)) {
            const { tokenId, balance, midPrice } = result!
            const tokenTrades = trades.filter((t) => t.asset_id === tokenId)
            const avgEntryPrice = calculateAvgEntryPrice(tokenTrades)
            const unrealizedPnl = midPrice > 0 ? (midPrice - avgEntryPrice) * balance : 0
            const latestTrade = tokenTrades[0]

            positions.push({
                instrument: tokenId,
                side: "long",
                quantity: balance,
                entryPrice: avgEntryPrice,
                currentPrice: midPrice > 0 ? midPrice : undefined,
                unrealizedPnl,
                metadata: {
                    venue: "polymarket",
                    market: latestTrade?.market,
                    outcome: latestTrade?.outcome,
                },
            })
        }

        this.positionsCache = { positions, fetchedAt: Date.now() }
        return positions
    }

    async getAccountState(): Promise<AccountState> {
        const [usdcBalance, positions] = await Promise.all([
            this.client.getBalance(),
            this.getPositions(),
        ])

        let openPnl = 0
        let totalExposure = 0

        for (const pos of positions) {
            openPnl += pos.unrealizedPnl ?? 0
            totalExposure += pos.quantity * pos.entryPrice
        }

        const totalEquity = usdcBalance + totalExposure + openPnl

        return {
            balance: usdcBalance,
            equity: totalEquity,
            buyingPower: usdcBalance,
            marginUsed: totalExposure,
            marginAvailable: usdcBalance,
            openPnl,
            dayPnl: 0,
        }
    }

    async getWorkingOrders(): Promise<WorkingOrder[]> {
        const orders = await this.client.getOpenOrders()
        return orders.map((order) => {
            const quantity = Number(order.original_size)
            const filledQuantity = Number(order.size_matched)
            const submittedAt = Date.parse(order.created_at)

            return {
                orderId: order.id,
                instrument: order.asset_id,
                status: mapOpenOrderStatus(order),
                quantity,
                filledQuantity,
                remainingQuantity: Math.max(quantity - filledQuantity, 0),
                submittedAt: Number.isFinite(submittedAt) ? submittedAt : Date.now(),
                updatedAt: Number.isFinite(submittedAt) ? submittedAt : Date.now(),
                side: order.side.toLowerCase() === "buy" ? "buy" : "sell",
                limitPrice: Number(order.price),
                metadata: {
                    market: order.market,
                    outcome: order.outcome,
                    orderType: order.order_type,
                    expiration: order.expiration,
                },
            }
        })
    }

    async submitOrder(intent: OrderIntent): Promise<ExecutionResult> {
        const tokenId = intent.instrument
        const polyOrderType = mapOrderType(intent)

        // Determine price — for market orders without a price, fetch the current best
        let price = intent.limitPrice
        if (price === undefined || price <= 0) {
            const currentPrice = await this.client.getPrice(tokenId, intent.side)
            // Add a small buffer for market orders to increase fill probability
            price = intent.side === "buy"
                ? Math.min(currentPrice * 1.02, 0.99)
                : Math.max(currentPrice * 0.98, 0.01)
        }

        const response = await this.client.createOrder({
            tokenId,
            side: intent.side,
            size: intent.quantity,
            price,
            orderType: polyOrderType,
            expiration: intent.metadata?.expiration as number | undefined,
            negRisk: intent.metadata?.negRisk as boolean | undefined,
        })

        return {
            orderId: response.orderID,
            status: mapPostOrderStatus(response.status),
            filledQuantity: response.status === "matched" ? intent.quantity : 0,
            fillPrice: response.status === "matched" ? price : undefined,
            timestamp: Date.now(),
        }
    }

    async cancelOrder(orderId: string): Promise<ExecutionResult> {
        await this.client.cancelOrder(orderId)

        // Fetch the order after cancellation to get final state
        try {
            const order = await this.client.getOrder(orderId)
            return mapOpenOrderToExecutionResult(order)
        } catch {
            // If the order is already gone, return a cancelled result
            return {
                orderId,
                status: "cancelled",
                filledQuantity: 0,
                timestamp: Date.now(),
            }
        }
    }

    async modifyOrder(orderId: string, changes: Partial<OrderIntent>): Promise<ExecutionResult> {
        // Polymarket does not support order modification — cancel and replace
        const existing = await this.client.getOrder(orderId)
        await this.client.cancelOrder(orderId)

        const newIntent: OrderIntent = {
            instrument: existing.asset_id,
            side: existing.side.toLowerCase() as "buy" | "sell",
            quantity: changes.quantity ?? (Number(existing.original_size) - Number(existing.size_matched)),
            orderType: changes.orderType ?? "limit",
            limitPrice: changes.limitPrice ?? Number(existing.price),
            timeInForce: changes.timeInForce ?? "gtc",
        }

        return this.submitOrder(newIntent)
    }

    async closePosition(instrument: string): Promise<ExecutionResult> {
        // instrument is the token ID — sell all held shares
        const balance = await this.client.getTokenBalance(instrument)

        if (balance <= 0) {
            const errorDetail = createExecutionErrorDetail("pre_validation", `No position found for token ${instrument}`, {
                code: "POSITION_NOT_FOUND",
                retryable: false,
                details: {
                    instrument,
                },
            })
            return {
                orderId: "",
                status: "rejected",
                filledQuantity: 0,
                timestamp: Date.now(),
                error: formatExecutionError(errorDetail),
                errorDetail,
            }
        }

        // Price the close order slightly below mid to increase fill probability
        let midPrice: number
        try {
            midPrice = await this.client.getMidpoint(instrument)
        } catch {
            // Fallback: get bid price
            midPrice = await this.client.getPrice(instrument, "sell")
        }

        const sellPrice = Math.max(midPrice * 0.98, 0.01)

        return this.submitOrder({
            instrument,
            side: "sell",
            quantity: balance,
            orderType: "limit",
            limitPrice: sellPrice,
            timeInForce: "fok",
        })
    }

    async getOrderStatus(orderId: string): Promise<ExecutionResult> {
        const order = await this.client.getOrder(orderId)
        return mapOpenOrderToExecutionResult(order)
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function calculateAvgEntryPrice(trades: PolymarketTrade[]): number {
    // Only consider BUY trades for entry price
    const buys = trades.filter((t) => t.side === "BUY")

    if (buys.length === 0) return 0

    let totalCost = 0
    let totalSize = 0

    for (const trade of buys) {
        const size = Number(trade.size)
        const price = Number(trade.price)
        totalCost += size * price
        totalSize += size
    }

    return totalSize > 0 ? totalCost / totalSize : 0
}

function mapOrderType(intent: OrderIntent): "GTC" | "GTD" | "FOK" | "FAK" {
    if (intent.orderType === "market") {
        return "FOK"
    }

    // Map timeInForce to Polymarket order types
    switch (intent.timeInForce) {
        case "gtc":
            return "GTC"
        case "ioc":
            return "FAK"
        case "fok":
            return "FOK"
        case "day":
            // Polymarket doesn't have a "day" equivalent, use GTC
            return "GTC"
        default:
            return "GTC"
    }
}

function mapPostOrderStatus(status: string): ExecutionResult["status"] {
    switch (status) {
        case "matched":
            return "filled"
        case "live":
            return "pending"
        default:
            return "pending"
    }
}

function mapOpenOrderStatus(order: PolymarketOpenOrder): ExecutionResult["status"] {
    const sizeMatched = Number(order.size_matched)
    const originalSize = Number(order.original_size)

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

function mapOpenOrderToExecutionResult(order: PolymarketOpenOrder): ExecutionResult {
    const sizeMatched = Number(order.size_matched)
    const price = Number(order.price)

    return {
        orderId: order.id,
        status: mapOpenOrderStatus(order),
        filledQuantity: sizeMatched,
        fillPrice: sizeMatched > 0 ? price : undefined,
        timestamp: Date.now(),
    }
}

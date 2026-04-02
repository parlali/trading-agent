/**
 * MT5 venue adapter -- implements the shared VenueAdapter interface
 * by proxying all calls to the Python worker via MT5Client.
 *
 * Key difference from Alpaca/Polymarket: MT5 orders are typically market
 * orders that fill immediately, so the order lifecycle is simpler.
 */

import type { AccountState, ExecutionResult, OrderIntent, Position, VenueAdapter } from "@valiq-trading/core"
import { MT5Client, type MT5Position, type MT5WorkerCredentials } from "./mt5-client"

export class MT5VenueAdapter implements VenueAdapter {
    private lastConnectedAt = 0
    private readonly CONNECTION_TTL = 60_000

    constructor(
        private readonly client: MT5Client,
        private readonly credentials: MT5WorkerCredentials
    ) {}

    /**
     * Ensure the Python worker has an active MT5 connection.
     * Called lazily before the first broker operation in a run.
     */
    async ensureConnected(): Promise<void> {
        if (Date.now() - this.lastConnectedAt < this.CONNECTION_TTL) {
            return
        }
        const health = await this.client.getHealth()
        if (!health.connected || health.login !== this.credentials.login) {
            await this.client.connect(this.credentials)
        }
        this.lastConnectedAt = Date.now()
    }

    async getPositions(): Promise<Position[]> {
        await this.ensureConnected()
        const raw = await this.client.getPositions()
        return raw.map(mapMT5Position)
    }

    async getAccountState(): Promise<AccountState> {
        await this.ensureConnected()
        const info = await this.client.getAccount()

        return {
            balance: info.balance,
            buyingPower: info.freeMargin,
            marginUsed: info.margin,
            marginAvailable: info.freeMargin,
            openPnl: info.profit,
            dayPnl: 0, // MT5 doesn't expose day P&L directly
        }
    }

    async submitOrder(intent: OrderIntent): Promise<ExecutionResult> {
        await this.ensureConnected()

        const result = await this.client.submitOrder({
            symbol: intent.instrument,
            side: intent.side,
            volume: intent.quantity,
            orderType: intent.orderType,
            price: intent.limitPrice ?? intent.stopPrice,
            stopLoss: intent.metadata?.stopLoss as number | undefined,
            takeProfit: intent.metadata?.takeProfit as number | undefined,
            magic: (intent.metadata?.magic as number) ?? 0,
            comment: (intent.metadata?.comment as string) ?? "",
        })

        return this.client.mapOrderResultToExecution(result)
    }

    async cancelOrder(orderId: string): Promise<ExecutionResult> {
        // MT5 market orders fill immediately; pending orders are rare for this use case.
        // If needed, this would modify/delete a pending order via the worker.
        return {
            orderId,
            status: "cancelled",
            filledQuantity: 0,
            timestamp: Date.now(),
            error: "Cancel not applicable for MT5 market orders",
        }
    }

    async modifyOrder(orderId: string, changes: Partial<OrderIntent>): Promise<ExecutionResult> {
        await this.ensureConnected()

        // In MT5, "modifying an order" typically means adjusting SL/TP on an open position
        const ticket = Number(orderId)
        if (Number.isNaN(ticket)) {
            return {
                orderId,
                status: "rejected",
                filledQuantity: 0,
                timestamp: Date.now(),
                error: "Invalid MT5 ticket number",
            }
        }

        const result = await this.client.modifyPosition({
            ticket,
            stopLoss: changes.stopPrice ?? (changes.metadata?.stopLoss as number | undefined),
            takeProfit: changes.limitPrice ?? (changes.metadata?.takeProfit as number | undefined),
        })

        return this.client.mapOrderResultToExecution(result)
    }

    async closePosition(instrument: string): Promise<ExecutionResult> {
        await this.ensureConnected()

        // Find the position by instrument (symbol)
        const positions = await this.client.getPositions()
        const position = positions.find((p) => p.symbol === instrument)

        if (!position) {
            return {
                orderId: "",
                status: "rejected",
                filledQuantity: 0,
                timestamp: Date.now(),
                error: `No open MT5 position found for ${instrument}`,
            }
        }

        const result = await this.client.closePosition({ ticket: position.ticket })
        return this.client.mapOrderResultToExecution(result)
    }

    async getOrderStatus(orderId: string): Promise<ExecutionResult> {
        await this.ensureConnected()

        const ticket = Number(orderId)
        if (Number.isNaN(ticket)) {
            return {
                orderId,
                status: "rejected",
                filledQuantity: 0,
                timestamp: Date.now(),
                error: "Invalid MT5 ticket number",
            }
        }

        const status = await this.client.getOrderStatus(ticket)
        if (!status) {
            return {
                orderId,
                status: "filled", // Assume filled if not in pending or history (MT5 market orders fill instantly)
                filledQuantity: 0,
                timestamp: Date.now(),
            }
        }

        return {
            orderId,
            status: mapMT5OrderState(status.state),
            filledQuantity: status.volume,
            fillPrice: status.price,
            timestamp: Date.now(),
        }
    }

    /**
     * Emergency flatten -- close all open positions immediately.
     * Used by the emergency flatten risk rule.
     */
    async closeAllPositions(): Promise<{ closed: number; results: ExecutionResult[] }> {
        await this.ensureConnected()
        const response = await this.client.closeAllPositions()

        return {
            closed: response.closed,
            results: response.results.map((r) => this.client.mapOrderResultToExecution(r)),
        }
    }
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function mapMT5Position(raw: MT5Position): Position {
    return {
        instrument: raw.symbol,
        side: raw.type === "buy" ? "long" : "short",
        quantity: raw.volume,
        entryPrice: raw.openPrice,
        currentPrice: raw.currentPrice,
        unrealizedPnl: raw.profit,
        metadata: {
            ticket: raw.ticket,
            stopLoss: raw.stopLoss,
            takeProfit: raw.takeProfit,
            swap: raw.swap,
            commission: raw.commission,
            magic: raw.magic,
            comment: raw.comment,
            openTime: raw.openTime,
        },
    }
}

function mapMT5OrderState(
    state: string
): "pending" | "partially_filled" | "filled" | "rejected" | "cancelled" | "expired" | "timed_out" {
    switch (state) {
        case "filled":
            return "filled"
        case "partial":
            return "partially_filled"
        case "canceled":
        case "cancelled":
            return "cancelled"
        case "expired":
            return "expired"
        case "rejected":
            return "rejected"
        case "started":
        case "placed":
        default:
            return "pending"
    }
}

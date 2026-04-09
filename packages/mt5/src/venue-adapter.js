/**
 * MT5 venue adapter -- implements the shared VenueAdapter interface
 * by proxying all calls to the Python worker via MT5Client.
 *
 * Key difference from Alpaca/Polymarket: MT5 orders are typically market
 * orders that fill immediately, so the order lifecycle is simpler.
 */
import { createExecutionError, createExecutionErrorDetail, formatExecutionError, } from "@valiq-trading/core";
import { toMT5MarketSnapshot } from "./market-context";
export class MT5VenueAdapter {
    client;
    credentials;
    lastConnectedAt = 0;
    CONNECTION_TTL = 60_000;
    constructor(client, credentials) {
        this.client = client;
        this.credentials = credentials;
    }
    /**
     * Ensure the Python worker has an active MT5 connection.
     * Called lazily before the first broker operation in a run.
     */
    async ensureConnected() {
        if (Date.now() - this.lastConnectedAt < this.CONNECTION_TTL) {
            return;
        }
        const health = await this.client.getHealth();
        if (!health.connected || health.login !== this.credentials.login) {
            await this.client.connect(this.credentials);
        }
        this.lastConnectedAt = Date.now();
    }
    async getPositions() {
        await this.ensureConnected();
        const raw = await this.client.getPositions();
        return raw.map(mapMT5Position);
    }
    async getAccountState() {
        await this.ensureConnected();
        const info = await this.client.getAccount();
        return {
            balance: info.balance,
            equity: info.equity,
            buyingPower: info.freeMargin,
            marginUsed: info.margin,
            marginAvailable: info.freeMargin,
            openPnl: info.profit,
            dayPnl: 0, // MT5 doesn't expose day P&L directly
        };
    }
    async getWorkingOrders() {
        await this.ensureConnected();
        const orders = await this.client.getOpenOrders();
        return orders.map(mapMT5WorkingOrder);
    }
    async submitOrder(intent) {
        await this.ensureConnected();
        const result = await this.client.submitOrder({
            symbol: intent.instrument,
            side: intent.side,
            volume: intent.quantity,
            orderType: intent.orderType,
            price: intent.limitPrice ?? intent.stopPrice,
            stopLoss: intent.metadata?.stopLoss,
            takeProfit: intent.metadata?.takeProfit,
            magic: intent.metadata?.magic ?? 0,
            comment: intent.metadata?.comment ?? "",
        });
        return this.client.mapOrderResultToExecution(result);
    }
    async cancelOrder(orderId) {
        await this.ensureConnected();
        const ticket = Number(orderId);
        if (Number.isNaN(ticket)) {
            const errorDetail = createExecutionErrorDetail("pre_validation", "Invalid MT5 ticket number", {
                code: "INVALID_ORDER_ID",
                retryable: false,
                details: {
                    orderId,
                },
            });
            return {
                orderId,
                status: "rejected",
                filledQuantity: 0,
                timestamp: Date.now(),
                error: formatExecutionError(errorDetail),
                errorDetail,
            };
        }
        const result = await this.client.cancelOrder({ ticket });
        return this.client.mapOrderResultToExecution(result, {
            fallbackOrderId: orderId,
            successStatus: "cancelled",
            filledQuantity: 0,
        });
    }
    async modifyOrder(orderId, changes) {
        await this.ensureConnected();
        // In MT5, "modifying an order" typically means adjusting SL/TP on an open position
        const ticket = Number(orderId);
        if (Number.isNaN(ticket)) {
            const errorDetail = createExecutionErrorDetail("pre_validation", "Invalid MT5 ticket number", {
                code: "INVALID_ORDER_ID",
                retryable: false,
                details: {
                    orderId,
                },
            });
            return {
                orderId,
                status: "rejected",
                filledQuantity: 0,
                timestamp: Date.now(),
                error: formatExecutionError(errorDetail),
                errorDetail,
            };
        }
        const stopLoss = changes.stopPrice ?? changes.metadata?.stopLoss;
        const takeProfit = changes.limitPrice ?? changes.metadata?.takeProfit;
        if (stopLoss === undefined && takeProfit === undefined) {
            const errorDetail = createExecutionErrorDetail("pre_validation", "Provide newStopLoss, newTakeProfit, or both", {
                code: "MISSING_MODIFICATION_FIELDS",
                retryable: false,
                details: {
                    orderId,
                },
            });
            return {
                orderId,
                status: "rejected",
                filledQuantity: 0,
                timestamp: Date.now(),
                error: formatExecutionError(errorDetail),
                errorDetail,
            };
        }
        const result = await this.client.modifyPosition({
            ticket,
            stopLoss,
            takeProfit,
        });
        return this.client.mapOrderResultToExecution(result, {
            fallbackOrderId: orderId,
        });
    }
    async closePosition(instrument) {
        await this.ensureConnected();
        // Find the position by instrument (symbol)
        const positions = await this.client.getPositions();
        const position = positions.find((p) => p.symbol === instrument);
        if (!position) {
            const errorDetail = createExecutionErrorDetail("pre_validation", `No open MT5 position found for ${instrument}`, {
                code: "POSITION_NOT_FOUND",
                retryable: false,
                details: {
                    instrument,
                },
            });
            return {
                orderId: "",
                status: "rejected",
                filledQuantity: 0,
                timestamp: Date.now(),
                error: formatExecutionError(errorDetail),
                errorDetail,
            };
        }
        const result = await this.client.closePosition({ ticket: position.ticket });
        return this.client.mapOrderResultToExecution(result);
    }
    async getOrderStatus(orderId) {
        await this.ensureConnected();
        const ticket = Number(orderId);
        if (Number.isNaN(ticket)) {
            const errorDetail = createExecutionErrorDetail("pre_validation", "Invalid MT5 ticket number", {
                code: "INVALID_ORDER_ID",
                retryable: false,
                details: {
                    orderId,
                },
            });
            return {
                orderId,
                status: "rejected",
                filledQuantity: 0,
                timestamp: Date.now(),
                error: formatExecutionError(errorDetail),
                errorDetail,
            };
        }
        const status = await this.client.getOrderStatus(ticket);
        if (!status) {
            throw createExecutionError("venue", `MT5 order ${orderId} not found in order book or history`, {
                code: "ORDER_NOT_FOUND",
                retryable: false,
                details: {
                    orderId,
                },
            });
        }
        return {
            orderId,
            status: mapMT5OrderState(status.state),
            filledQuantity: status.volume,
            fillPrice: status.price,
            timestamp: Date.now(),
        };
    }
    async getSymbolInfo(symbol) {
        await this.ensureConnected();
        const results = await this.client.getSymbolInfo([symbol]);
        return results.length > 0 ? (results[0] ?? null) : null;
    }
    async verify(intent) {
        const symbolInfo = await this.getSymbolInfo(intent.instrument);
        if (!symbolInfo) {
            return {
                ok: false,
                status: "block",
                livePrices: {},
                proposedPrice: resolveMT5VerificationPrice(intent),
                message: `Symbol ${intent.instrument} not found or unavailable for MT5 price verification.`,
                details: {
                    instrument: intent.instrument,
                },
            };
        }
        const mid = (symbolInfo.bid + symbolInfo.ask) / 2;
        const comparisonPrice = resolveMT5ComparisonPrice(intent, symbolInfo);
        const proposedPrice = resolveMT5VerificationPrice(intent, symbolInfo);
        const drift = proposedPrice !== undefined ? proposedPrice - comparisonPrice : undefined;
        const driftPercent = comparisonPrice > 0 && drift !== undefined
            ? (drift / comparisonPrice) * 100
            : undefined;
        return {
            ok: true,
            livePrices: {
                bid: symbolInfo.bid,
                ask: symbolInfo.ask,
                mid,
                spread: Math.abs(symbolInfo.ask - symbolInfo.bid),
            },
            proposedPrice,
            drift,
            driftPercent,
            message: proposedPrice !== undefined
                ? `Compared proposed MT5 price ${proposedPrice} against live executable price ${comparisonPrice}.`
                : "Captured live MT5 market prices before submission.",
            details: {
                instrument: symbolInfo.symbol,
                digits: symbolInfo.digits,
                point: symbolInfo.point,
                sidePrice: resolveMT5ComparisonPrice(intent, symbolInfo),
            },
        };
    }
    async getMarketSnapshot(symbols) {
        if (symbols.length === 0) {
            return [];
        }
        await this.ensureConnected();
        const results = await this.client.getSymbolInfo(symbols);
        return results.map(toMT5MarketSnapshot);
    }
    /**
     * Emergency flatten -- close all open positions immediately.
     * Used by the emergency flatten risk rule.
     */
    async closeAllPositions() {
        await this.ensureConnected();
        const response = await this.client.closeAllPositions();
        return {
            closed: response.closed,
            results: response.results.map((r) => this.client.mapOrderResultToExecution(r)),
        };
    }
}
// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------
function mapMT5Position(raw) {
    return {
        instrument: raw.symbol,
        side: raw.type === "buy" ? "long" : "short",
        quantity: raw.volume,
        entryPrice: raw.openPrice,
        currentPrice: raw.currentPrice,
        unrealizedPnl: raw.profit,
        stopLoss: raw.stopLoss > 0 ? raw.stopLoss : undefined,
        takeProfit: raw.takeProfit > 0 ? raw.takeProfit : undefined,
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
    };
}
function resolveMT5VerificationPrice(intent, symbolInfo) {
    if (typeof intent.limitPrice === "number") {
        return intent.limitPrice;
    }
    if (typeof intent.stopPrice === "number") {
        return intent.stopPrice;
    }
    const estimatedPrice = intent.metadata?.estimatedPrice;
    if (typeof estimatedPrice === "number") {
        return estimatedPrice;
    }
    if (symbolInfo) {
        return intent.side === "buy" ? symbolInfo.ask : symbolInfo.bid;
    }
    return undefined;
}
function resolveMT5ComparisonPrice(intent, symbolInfo) {
    if (intent.orderType === "market") {
        return intent.side === "buy" ? symbolInfo.ask : symbolInfo.bid;
    }
    return (symbolInfo.bid + symbolInfo.ask) / 2;
}
function mapMT5WorkingOrder(raw) {
    const quantity = raw.volumeInitial;
    const remainingQuantity = raw.volumeCurrent;
    const filledQuantity = Math.max(quantity - remainingQuantity, 0);
    return {
        orderId: String(raw.ticket),
        instrument: raw.symbol,
        status: mapMT5OrderState(raw.state),
        quantity,
        filledQuantity,
        remainingQuantity,
        submittedAt: raw.timeSetup || Date.now(),
        updatedAt: raw.timeDone || raw.timeSetup || Date.now(),
        side: raw.type.startsWith("buy") ? "buy" : "sell",
        limitPrice: raw.priceOpen > 0 ? raw.priceOpen : undefined,
        stopPrice: raw.stopLoss > 0 ? raw.stopLoss : undefined,
        metadata: {
            takeProfit: raw.takeProfit > 0 ? raw.takeProfit : undefined,
            comment: raw.comment,
            magic: raw.magic,
            type: raw.type,
        },
    };
}
function mapMT5OrderState(state) {
    switch (state) {
        case "filled":
            return "filled";
        case "partial":
            return "partially_filled";
        case "canceled":
        case "cancelled":
            return "cancelled";
        case "expired":
            return "expired";
        case "rejected":
            return "rejected";
        case "started":
        case "placed":
        default:
            return "pending";
    }
}

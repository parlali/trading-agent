import { type AccountState, type ExecutionResult, type OrderIntent, type PriceVerification, type PriceVerifier, type Position, type VenueAdapter, type WorkingOrder } from "@valiq-trading/core";
import { BinanceClient } from "./binance-client";
import type { BinanceMarketSnapshot } from "./market-context";
export interface BinanceSymbolRules {
    symbol: string;
    minQty: number;
    maxQty: number;
    stepSize: number;
    tickSize: number;
    minNotional: number;
    pricePrecision: number;
    quantityPrecision: number;
}
export interface BinanceMarketPrice {
    symbol: string;
    markPrice: number;
    indexPrice: number;
    bestBid: number;
    bestAsk: number;
    spread: number;
    fundingRate: number;
    nextFundingTime: number;
}
export interface BinanceOrderBookLevel {
    price: number;
    quantity: number;
}
export interface BinanceOrderBook {
    symbol: string;
    lastUpdateId: number;
    bids: BinanceOrderBookLevel[];
    asks: BinanceOrderBookLevel[];
    eventTime?: number;
    transactionTime?: number;
}
export declare class BinanceVenueAdapter implements VenueAdapter, PriceVerifier {
    private readonly client;
    private readonly symbolRulesCache;
    private positionModeInitialized;
    constructor(client: BinanceClient);
    getPositions(): Promise<Position[]>;
    getAccountState(): Promise<AccountState>;
    getWorkingOrders(): Promise<WorkingOrder[]>;
    submitOrder(intent: OrderIntent): Promise<ExecutionResult>;
    cancelOrder(orderId: string): Promise<ExecutionResult>;
    modifyOrder(orderId: string, changes: Partial<OrderIntent>): Promise<ExecutionResult>;
    closePosition(instrument: string): Promise<ExecutionResult>;
    getOrderStatus(orderId: string): Promise<ExecutionResult>;
    getMarketPrice(symbol: string): Promise<BinanceMarketPrice>;
    getOrderBook(symbol: string, limit?: number): Promise<BinanceOrderBook>;
    getCurrentMarkPrice(symbol: string): Promise<number>;
    getCurrentFundingRate(symbol: string): Promise<number>;
    verify(intent: OrderIntent): Promise<PriceVerification>;
    getMarketSnapshot(symbols: string[]): Promise<BinanceMarketSnapshot[]>;
    normalizeQuantity(symbol: string, quantity: number): Promise<number>;
    normalizePrice(symbol: string, price: number): Promise<number>;
    updateProtectionOrders(config: {
        instrument: string;
        stopLoss?: number;
        takeProfit?: number;
    }): Promise<{
        cancelledOrderIds: string[];
        createdOrderIds: string[];
    }>;
    closeAllPositions(): Promise<{
        closed: number;
        results: ExecutionResult[];
    }>;
    private ensureTradingMode;
    private getSymbolRules;
}
//# sourceMappingURL=venue-adapter.d.ts.map
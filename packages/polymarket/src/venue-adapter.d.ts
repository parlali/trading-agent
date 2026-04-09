import { type AccountState, type ExecutionResult, type OrderIntent, type PriceVerification, type PriceVerifier, type Position, type VenueAdapter, type WorkingOrder } from "@valiq-trading/core";
import type { PolymarketClient, PolymarketOrderBook } from "./polymarket-client";
export interface PolymarketMarketPrice {
    tokenId: string;
    midpoint: number;
    bestBid: number;
    bestAsk: number;
    spread: number;
    executablePrice?: number;
    executableSide?: "buy" | "sell";
}
export interface PolymarketMarketSearchResult {
    conditionId: string;
    question: string;
    category: string;
    description: string;
    marketSlug: string;
    active: boolean;
    closed: boolean;
    negRisk: boolean;
    minimumOrderSize: number;
    minimumTickSize: number;
    volume?: number;
    liquidity?: number;
    endDateIso: string;
    tokens: Array<{
        tokenId: string;
        outcome: string;
        midpoint?: number;
        bestBid?: number;
        bestAsk?: number;
        spread?: number;
    }>;
}
export declare class PolymarketVenueAdapter implements VenueAdapter, PriceVerifier {
    private readonly client;
    private positionsCache;
    private readonly POSITIONS_CACHE_TTL;
    constructor(client: PolymarketClient);
    getPrice(tokenId: string, side: "buy" | "sell"): Promise<number>;
    getMarketPrice(tokenId: string, side?: "buy" | "sell"): Promise<PolymarketMarketPrice>;
    getOrderBook(tokenId: string): Promise<PolymarketOrderBook>;
    searchMarkets(params: {
        query?: string;
        conditionId?: string;
        limit?: number;
    }): Promise<PolymarketMarketSearchResult[]>;
    getPositions(): Promise<Position[]>;
    getAccountState(): Promise<AccountState>;
    getWorkingOrders(): Promise<WorkingOrder[]>;
    submitOrder(intent: OrderIntent): Promise<ExecutionResult>;
    cancelOrder(orderId: string): Promise<ExecutionResult>;
    modifyOrder(orderId: string, changes: Partial<OrderIntent>): Promise<ExecutionResult>;
    closePosition(instrument: string): Promise<ExecutionResult>;
    getOrderStatus(orderId: string): Promise<ExecutionResult>;
    verify(intent: OrderIntent): Promise<PriceVerification>;
    private buildMarketSearchResult;
}
//# sourceMappingURL=venue-adapter.d.ts.map
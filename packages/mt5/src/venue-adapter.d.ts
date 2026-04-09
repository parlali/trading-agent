/**
 * MT5 venue adapter -- implements the shared VenueAdapter interface
 * by proxying all calls to the Python worker via MT5Client.
 *
 * Key difference from Alpaca/Polymarket: MT5 orders are typically market
 * orders that fill immediately, so the order lifecycle is simpler.
 */
import { type AccountState, type ExecutionResult, type OrderIntent, type PriceVerification, type PriceVerifier, type Position, type VenueAdapter, type WorkingOrder } from "@valiq-trading/core";
import { MT5Client, type MT5SymbolInfo, type MT5WorkerCredentials } from "./mt5-client";
import { type MT5MarketSnapshot } from "./market-context";
export declare class MT5VenueAdapter implements VenueAdapter, PriceVerifier {
    private readonly client;
    private readonly credentials;
    private lastConnectedAt;
    private readonly CONNECTION_TTL;
    constructor(client: MT5Client, credentials: MT5WorkerCredentials);
    /**
     * Ensure the Python worker has an active MT5 connection.
     * Called lazily before the first broker operation in a run.
     */
    ensureConnected(): Promise<void>;
    getPositions(): Promise<Position[]>;
    getAccountState(): Promise<AccountState>;
    getWorkingOrders(): Promise<WorkingOrder[]>;
    submitOrder(intent: OrderIntent): Promise<ExecutionResult>;
    cancelOrder(orderId: string): Promise<ExecutionResult>;
    modifyOrder(orderId: string, changes: Partial<OrderIntent>): Promise<ExecutionResult>;
    closePosition(instrument: string): Promise<ExecutionResult>;
    getOrderStatus(orderId: string): Promise<ExecutionResult>;
    getSymbolInfo(symbol: string): Promise<MT5SymbolInfo | null>;
    verify(intent: OrderIntent): Promise<PriceVerification>;
    getMarketSnapshot(symbols: string[]): Promise<MT5MarketSnapshot[]>;
    /**
     * Emergency flatten -- close all open positions immediately.
     * Used by the emergency flatten risk rule.
     */
    closeAllPositions(): Promise<{
        closed: number;
        results: ExecutionResult[];
    }>;
}
//# sourceMappingURL=venue-adapter.d.ts.map
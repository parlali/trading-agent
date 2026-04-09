export declare const reconcileProviderPortfolio: import("convex/server").RegisteredMutation<"public", {
    venue: string;
    app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures";
    positions: {
        metadata?: string | undefined;
        currentPrice?: number | undefined;
        unrealizedPnl?: number | undefined;
        stopLoss?: number | undefined;
        takeProfit?: number | undefined;
        instrument: string;
        side: "long" | "short";
        quantity: number;
        entryPrice: number;
    }[];
    source: "startup_sync" | "periodic_sync" | "post_run_sync";
    serviceToken: string;
    accountState: {
        balance: number;
        equity: number;
        buyingPower: number;
        marginUsed: number;
        marginAvailable: number;
        openPnl: number;
        dayPnl: number;
    };
    workingOrders: {
        side?: "buy" | "sell" | undefined;
        limitPrice?: number | undefined;
        stopPrice?: number | undefined;
        metadata?: string | undefined;
        avgFillPrice?: number | undefined;
        instrument: string;
        quantity: number;
        orderId: string;
        status: "pending" | "partially_filled" | "filled" | "rejected" | "cancelled" | "expired" | "timed_out";
        filledQuantity: number;
        updatedAt: number;
        remainingQuantity: number;
        submittedAt: number;
    }[];
}, Promise<{
    app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures";
    source: "startup_sync" | "periodic_sync" | "post_run_sync";
    positionCount: number;
    pendingOrderCount: number;
    driftDetected: boolean;
    driftSummary: string | undefined;
}>>;
export declare const recordProviderSyncFailure: import("convex/server").RegisteredMutation<"public", {
    error: string;
    app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures";
    serviceToken: string;
}, Promise<import("convex/values").GenericId<"provider_sync_state">>>;
//# sourceMappingURL=portfolio.d.ts.map
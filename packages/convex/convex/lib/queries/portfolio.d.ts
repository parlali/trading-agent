export declare const getPortfolioFreshness: import("convex/server").RegisteredQuery<"public", {
    app?: "alpaca-options" | "polymarket" | "mt5" | "binance-futures" | undefined;
    serviceToken?: string | undefined;
}, Promise<{
    app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures";
    accountScope: "single-account-per-venue";
    lastSyncedAt: number | undefined;
    lastVerifiedAt: number | undefined;
    providerStatus: "healthy" | "degraded" | "stale";
    stale: boolean;
    driftDetected: boolean;
    lastError: string | undefined;
    lastDriftSummary: string | undefined;
    positionCount: number;
    pendingOrderCount: number;
}[]>>;
export declare const getPortfolioPositions: import("convex/server").RegisteredQuery<"public", {
    strategyId?: import("convex/values").GenericId<"strategies"> | undefined;
    app?: "alpaca-options" | "polymarket" | "mt5" | "binance-futures" | undefined;
    serviceToken?: string | undefined;
}, Promise<{
    app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures";
    strategyId: string | undefined;
    strategyName: string | undefined;
    ownershipStatus: "owned" | "unowned" | "orphaned";
    instrument: string;
    side: "long" | "short";
    quantity: number;
    entryPrice: number;
    currentPrice: number | undefined;
    unrealizedPnl: number | undefined;
    stopLoss: number | undefined;
    takeProfit: number | undefined;
    syncedAt: number;
    metadata: unknown;
}[]>>;
export declare const getPortfolioPendingOrders: import("convex/server").RegisteredQuery<"public", {
    strategyId?: import("convex/values").GenericId<"strategies"> | undefined;
    app?: "alpaca-options" | "polymarket" | "mt5" | "binance-futures" | undefined;
    serviceToken?: string | undefined;
}, Promise<{
    app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures";
    strategyId: string | undefined;
    strategyName: string | undefined;
    ownershipStatus: "owned" | "unowned" | "orphaned";
    orderId: string;
    instrument: string;
    venue: string;
    status: "pending" | "partially_filled" | "filled" | "rejected" | "cancelled" | "expired" | "timed_out";
    action: "entry" | "adjustment" | "close" | "modify" | "cancel" | undefined;
    quantity: number;
    filledQuantity: number;
    remainingQuantity: number;
    side: "buy" | "sell" | undefined;
    limitPrice: number | undefined;
    stopPrice: number | undefined;
    avgFillPrice: number | undefined;
    submittedAt: number;
    updatedAt: number;
    metadata: unknown;
}[]>>;
export declare const getPortfolioTradeHistory: import("convex/server").RegisteredQuery<"public", {
    limit?: number | undefined;
    strategyId?: import("convex/values").GenericId<"strategies"> | undefined;
    app?: "alpaca-options" | "polymarket" | "mt5" | "binance-futures" | undefined;
}, Promise<{
    eventId: string;
    timestamp: number;
    app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures";
    strategyId: string;
    strategyName: string;
    runId: string;
    orderId: string | undefined;
    instrument: string | undefined;
    eventType: "filled" | "rejected" | "cancelled" | "submission" | "intent" | "validation" | "fill_update";
    action: "entry" | "adjustment" | "close" | "modify" | "cancel" | undefined;
    status: "pending" | "partially_filled" | "filled" | "rejected" | "cancelled" | "expired" | "timed_out" | undefined;
    side: "buy" | "sell" | undefined;
    quantity: number | undefined;
    filledQuantity: number | undefined;
    price: number | undefined;
    summary: string;
}[]>>;
export declare const getPortfolioEquitySeries: import("convex/server").RegisteredQuery<"public", {
    app?: "alpaca-options" | "polymarket" | "mt5" | "binance-futures" | undefined;
    timeRange: "24h" | "7d" | "30d" | "90d" | "all";
}, Promise<{
    timeRange: "24h" | "7d" | "30d" | "90d" | "all";
    app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures" | undefined;
    start: number;
    end: number;
    latest: {
        timestamp: number;
        total: number;
        providers: {
            [k: string]: number;
        };
    } | null;
    series: {
        timestamp: number;
        total: number;
        providers: {
            [k: string]: number;
        };
    }[];
}>>;
//# sourceMappingURL=portfolio.d.ts.map
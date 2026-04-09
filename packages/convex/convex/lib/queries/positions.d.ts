export declare const getOpenPositions: import("convex/server").RegisteredQuery<"public", {
    strategyId: import("convex/values").GenericId<"strategies">;
}, Promise<{
    _id: import("convex/values").GenericId<"positions">;
    _creationTime: number;
    metadata?: string | undefined;
    currentPrice?: number | undefined;
    unrealizedPnl?: number | undefined;
    instrument: string;
    side: "long" | "short";
    quantity: number;
    strategyId: import("convex/values").GenericId<"strategies">;
    app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures";
    entryPrice: number;
    syncedAt: number;
}[]>>;
export declare const getStrategyPositions: import("convex/server").RegisteredQuery<"public", {
    strategyId: import("convex/values").GenericId<"strategies">;
    serviceToken: string;
}, Promise<{
    _id: import("convex/values").GenericId<"positions">;
    _creationTime: number;
    metadata?: string | undefined;
    currentPrice?: number | undefined;
    unrealizedPnl?: number | undefined;
    instrument: string;
    side: "long" | "short";
    quantity: number;
    strategyId: import("convex/values").GenericId<"strategies">;
    app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures";
    entryPrice: number;
    syncedAt: number;
}[]>>;
//# sourceMappingURL=positions.d.ts.map
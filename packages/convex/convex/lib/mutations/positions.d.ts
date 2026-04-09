export declare const syncPositions: import("convex/server").RegisteredMutation<"public", {
    strategyId: import("convex/values").GenericId<"strategies">;
    app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures";
    positions: {
        metadata?: string | undefined;
        currentPrice?: number | undefined;
        unrealizedPnl?: number | undefined;
        instrument: string;
        side: "long" | "short";
        quantity: number;
        entryPrice: number;
    }[];
    serviceToken: string;
}, Promise<void>>;
//# sourceMappingURL=positions.d.ts.map
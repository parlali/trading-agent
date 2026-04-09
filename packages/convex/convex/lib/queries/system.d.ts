export declare const getSystemState: import("convex/server").RegisteredQuery<"public", {
    serviceToken?: string | undefined;
}, Promise<{
    globalKillSwitch: boolean;
    appKillSwitches: {
        binance_futures?: boolean | undefined;
        polymarket: boolean;
        mt5: boolean;
        alpaca_options: boolean;
    };
    updatedAt: number;
}>>;
export declare const getAppHealth: import("convex/server").RegisteredQuery<"public", {}, Promise<{
    _id: import("convex/values").GenericId<"app_heartbeats">;
    _creationTime: number;
    metadata?: any;
    app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures" | "backend";
    status: "healthy" | "degraded" | "unhealthy";
    lastHeartbeat: number;
}[]>>;
export declare const getManualRunRequests: import("convex/server").RegisteredQuery<"public", {
    app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures";
    serviceToken: string;
}, Promise<{
    _id: import("convex/values").GenericId<"manual_run_requests">;
    _creationTime: number;
    strategyId: import("convex/values").GenericId<"strategies">;
    app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures";
    requestedAt: number;
}[]>>;
//# sourceMappingURL=system.d.ts.map
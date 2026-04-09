export declare const createAlert: import("convex/server").RegisteredMutation<"public", {
    strategyId?: import("convex/values").GenericId<"strategies"> | undefined;
    app?: "alpaca-options" | "polymarket" | "mt5" | "binance-futures" | "backend" | undefined;
    message: string;
    severity: "critical" | "warning" | "info";
    serviceToken: string;
}, Promise<void>>;
export declare const acknowledgeAlert: import("convex/server").RegisteredMutation<"public", {
    alertId: import("convex/values").GenericId<"alerts">;
}, Promise<void>>;
export declare const reportHeartbeat: import("convex/server").RegisteredMutation<"public", {
    metadata?: any;
    app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures" | "backend";
    status: "healthy" | "degraded" | "unhealthy";
    serviceToken: string;
}, Promise<import("convex/values").GenericId<"app_heartbeats">>>;
export declare const snapshotAccountState: import("convex/server").RegisteredMutation<"public", {
    equity?: number | undefined;
    venue: string;
    app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures" | "backend";
    balance: number;
    buyingPower: number;
    marginUsed: number;
    marginAvailable: number;
    openPnl: number;
    dayPnl: number;
    serviceToken: string;
}, Promise<import("convex/values").GenericId<"account_snapshots">>>;
export declare const setKillSwitch: import("convex/server").RegisteredMutation<"public", {
    updatedBy?: string | undefined;
    enabled: boolean;
    scope: "alpaca-options" | "polymarket" | "mt5" | "binance-futures" | "global";
}, Promise<import("convex/values").GenericId<"system_state">>>;
export declare const clearManualRunRequest: import("convex/server").RegisteredMutation<"public", {
    serviceToken: string;
    requestId: import("convex/values").GenericId<"manual_run_requests">;
}, Promise<void>>;
//# sourceMappingURL=system.d.ts.map
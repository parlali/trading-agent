export declare const upsertStrategy: import("convex/server").RegisteredMutation<"public", {
    id?: import("convex/values").GenericId<"strategies"> | undefined;
    serviceToken?: string | undefined;
    app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures";
    name: string;
    enabled: boolean;
    schedule: string;
    policy: any;
    context: string;
}, Promise<import("convex/values").GenericId<"strategies">>>;
export declare const disableStrategy: import("convex/server").RegisteredMutation<"public", {
    serviceToken?: string | undefined;
    strategyId: import("convex/values").GenericId<"strategies">;
}, Promise<void>>;
export declare const deleteStrategy: import("convex/server").RegisteredMutation<"public", {
    serviceToken?: string | undefined;
    strategyId: import("convex/values").GenericId<"strategies">;
}, Promise<{
    runs: number;
    agentLogs: number;
    tradeEvents: number;
    orders: number;
    orderTransitions: number;
    positions: number;
    instrumentClaims: number;
    positionSyncs: number;
    providerPositions: number;
    providerWorkingOrders: number;
    providerSyncStates: number;
    accountSnapshots: number;
    appHeartbeats: number;
    manualRunRequests: number;
    alerts: number;
}>>;
export declare const deleteAllStrategies: import("convex/server").RegisteredMutation<"public", {
    serviceToken: string;
}, Promise<{
    strategies: number;
    runs: number;
    agentLogs: number;
    tradeEvents: number;
    orders: number;
    orderTransitions: number;
    positions: number;
    instrumentClaims: number;
    positionSyncs: number;
    providerPositions: number;
    providerWorkingOrders: number;
    providerSyncStates: number;
    accountSnapshots: number;
    appHeartbeats: number;
    manualRunRequests: number;
    alerts: number;
}>>;
export declare const triggerManualRun: import("convex/server").RegisteredMutation<"public", {
    strategyId: import("convex/values").GenericId<"strategies">;
}, Promise<import("convex/values").GenericId<"manual_run_requests">>>;
export declare const stopRun: import("convex/server").RegisteredMutation<"public", {
    runId: import("convex/values").GenericId<"strategy_runs">;
}, Promise<void>>;
export declare const deleteRun: import("convex/server").RegisteredMutation<"public", {
    runId: import("convex/values").GenericId<"strategy_runs">;
}, Promise<void>>;
export declare const deleteAllRuns: import("convex/server").RegisteredMutation<"public", {
    serviceToken?: string | undefined;
    strategyId: import("convex/values").GenericId<"strategies">;
}, Promise<{
    deleted: number;
}>>;
export declare const replaceAllStrategies: import("convex/server").RegisteredMutation<"public", {
    strategies: {
        app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures";
        name: string;
        enabled: boolean;
        schedule: string;
        policy: any;
        context: string;
    }[];
    serviceToken: string;
}, Promise<{
    importedStrategies: number;
    deleted: {
        strategies: number;
        runs: number;
        agentLogs: number;
        tradeEvents: number;
        orders: number;
        orderTransitions: number;
        positions: number;
        instrumentClaims: number;
        positionSyncs: number;
        providerPositions: number;
        providerWorkingOrders: number;
        providerSyncStates: number;
        accountSnapshots: number;
        appHeartbeats: number;
        manualRunRequests: number;
        alerts: number;
    };
}>>;
//# sourceMappingURL=strategies.d.ts.map
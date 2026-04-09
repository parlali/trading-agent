export declare const getRunHistory: import("convex/server").RegisteredQuery<"public", {
    limit?: number | undefined;
    strategyId: import("convex/values").GenericId<"strategies">;
}, Promise<{
    _id: import("convex/values").GenericId<"strategy_runs">;
    _creationTime: number;
    error?: string | undefined;
    trigger?: "cron" | "manual" | "callback" | undefined;
    endedAt?: number | undefined;
    summary?: string | undefined;
    callbackRequestedMinutes?: number | undefined;
    callbackFiresAt?: number | undefined;
    strategyId: import("convex/values").GenericId<"strategies">;
    app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures";
    status: "running" | "completed" | "failed";
    startedAt: number;
}[]>>;
export declare const getLastCompletedRunSummary: import("convex/server").RegisteredQuery<"public", {
    strategyId: import("convex/values").GenericId<"strategies">;
    serviceToken: string;
}, Promise<{
    summary: string;
    endedAt: number | undefined;
} | null>>;
export declare const getActiveRun: import("convex/server").RegisteredQuery<"public", {
    serviceToken?: string | undefined;
    strategyId: import("convex/values").GenericId<"strategies">;
}, Promise<{
    _id: import("convex/values").GenericId<"strategy_runs">;
    _creationTime: number;
    error?: string | undefined;
    trigger?: "cron" | "manual" | "callback" | undefined;
    endedAt?: number | undefined;
    summary?: string | undefined;
    callbackRequestedMinutes?: number | undefined;
    callbackFiresAt?: number | undefined;
    strategyId: import("convex/values").GenericId<"strategies">;
    app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures";
    status: "running" | "completed" | "failed";
    startedAt: number;
} | null>>;
export declare const getAgentLogs: import("convex/server").RegisteredQuery<"public", {
    runId: import("convex/values").GenericId<"strategy_runs">;
}, Promise<{
    _id: import("convex/values").GenericId<"agent_logs">;
    _creationTime: number;
    toolName?: string | undefined;
    toolInput?: string | undefined;
    toolOutput?: string | undefined;
    timestamp: number;
    runId: import("convex/values").GenericId<"strategy_runs">;
    strategyId: import("convex/values").GenericId<"strategies">;
    sequence: number;
    role: "system" | "user" | "assistant" | "tool";
    content: string;
}[]>>;
export declare const getScheduleOverview: import("convex/server").RegisteredQuery<"public", {}, Promise<{
    _id: import("convex/values").GenericId<"strategies">;
    name: string;
    app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures";
    enabled: boolean;
    schedule: string;
    latestRun: {
        _id: import("convex/values").GenericId<"strategy_runs">;
        status: "running" | "completed" | "failed";
        trigger: "cron" | "manual" | "callback";
        startedAt: number;
        endedAt: number | undefined;
        error: string | undefined;
    } | null;
    isRunning: boolean;
    pendingCallback: {
        requestedMinutes: number;
        firesAt: number;
        scheduledByRunId: string;
    } | null;
}[]>>;
//# sourceMappingURL=runs.d.ts.map
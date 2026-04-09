export declare const createRun: import("convex/server").RegisteredMutation<"public", {
    trigger?: "cron" | "manual" | "callback" | undefined;
    strategyId: import("convex/values").GenericId<"strategies">;
    app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures";
    serviceToken: string;
}, Promise<import("convex/values").GenericId<"strategy_runs">>>;
export declare const recoverStaleRunningRuns: import("convex/server").RegisteredMutation<"public", {
    olderThanMs?: number | undefined;
    serviceToken: string;
}, Promise<{
    recovered: number;
}>>;
export declare const recoverRunningRuns: import("convex/server").RegisteredMutation<"public", {
    serviceToken: string;
}, Promise<{
    recovered: number;
}>>;
export declare const recordRunCallback: import("convex/server").RegisteredMutation<"public", {
    runId: import("convex/values").GenericId<"strategy_runs">;
    callbackRequestedMinutes: number;
    callbackFiresAt: number;
    serviceToken: string;
}, Promise<void>>;
export declare const updateRun: import("convex/server").RegisteredMutation<"public", {
    error?: string | undefined;
    summary?: string | undefined;
    runId: import("convex/values").GenericId<"strategy_runs">;
    status: "running" | "completed" | "failed";
    serviceToken: string;
}, Promise<void>>;
export declare const logAgentMessage: import("convex/server").RegisteredMutation<"public", {
    toolName?: string | undefined;
    toolInput?: string | undefined;
    toolOutput?: string | undefined;
    runId: import("convex/values").GenericId<"strategy_runs">;
    strategyId: import("convex/values").GenericId<"strategies">;
    sequence: number;
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    serviceToken: string;
}, Promise<void>>;
export declare const logTradeEvent: import("convex/server").RegisteredMutation<"public", {
    runId: import("convex/values").GenericId<"strategy_runs">;
    strategyId: import("convex/values").GenericId<"strategies">;
    eventType: "filled" | "rejected" | "cancelled" | "submission" | "intent" | "validation" | "fill_update";
    payload: string;
    serviceToken: string;
}, Promise<void>>;
export declare const upsertOrder: import("convex/server").RegisteredMutation<"public", {
    metadata?: any;
    avgFillPrice?: number | undefined;
    venue: string;
    instrument: string;
    quantity: number;
    orderId: string;
    action: "entry" | "adjustment" | "close" | "modify" | "cancel";
    runId: import("convex/values").GenericId<"strategy_runs">;
    strategyId: import("convex/values").GenericId<"strategies">;
    status: "pending" | "partially_filled" | "filled" | "rejected" | "cancelled" | "expired" | "timed_out";
    filledQuantity: number;
    intent: any;
    updatedAt: number;
    remainingQuantity: number;
    submittedAt: number;
    polling: {
        nextCheckAt?: number | undefined;
        timedOutAt?: number | undefined;
        lastError?: string | undefined;
        resumeToken?: string | undefined;
        timeoutMs: number;
        startedAt: number;
        pollIntervalMs: number;
        lastCheckedAt: number;
    };
    serviceToken: string;
}, Promise<import("convex/values").GenericId<"orders">>>;
export declare const logOrderTransition: import("convex/server").RegisteredMutation<"public", {
    reason?: string | undefined;
    previousStatus?: "pending" | "partially_filled" | "filled" | "rejected" | "cancelled" | "expired" | "timed_out" | undefined;
    details?: any;
    orderId: string;
    timestamp: number;
    runId: import("convex/values").GenericId<"strategy_runs">;
    strategyId: import("convex/values").GenericId<"strategies">;
    status: "pending" | "partially_filled" | "filled" | "rejected" | "cancelled" | "expired" | "timed_out";
    type: "submission" | "status_change" | "modify_attempt" | "cancel_attempt" | "timeout_decision" | "terminal";
    sequence: number;
    serviceToken: string;
}, Promise<void>>;
//# sourceMappingURL=orders.d.ts.map
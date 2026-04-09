export declare const getOrderById: import("convex/server").RegisteredQuery<"public", {
    serviceToken?: string | undefined;
    orderId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"orders">;
    _creationTime: number;
    metadata?: any;
    app?: "alpaca-options" | "polymarket" | "mt5" | "binance-futures" | undefined;
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
} | null>>;
export declare const getActiveOrders: import("convex/server").RegisteredQuery<"public", {
    serviceToken?: string | undefined;
    strategyId: import("convex/values").GenericId<"strategies">;
}, Promise<{
    _id: import("convex/values").GenericId<"orders">;
    _creationTime: number;
    metadata?: any;
    app?: "alpaca-options" | "polymarket" | "mt5" | "binance-futures" | undefined;
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
}[]>>;
export declare const getOrderTransitions: import("convex/server").RegisteredQuery<"public", {
    orderId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"order_transitions">;
    _creationTime: number;
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
}[]>>;
export declare const getTradeEvents: import("convex/server").RegisteredQuery<"public", {
    runId: import("convex/values").GenericId<"strategy_runs">;
}, Promise<{
    _id: import("convex/values").GenericId<"trade_events">;
    _creationTime: number;
    app?: "alpaca-options" | "polymarket" | "mt5" | "binance-futures" | undefined;
    timestamp: number;
    runId: import("convex/values").GenericId<"strategy_runs">;
    strategyId: import("convex/values").GenericId<"strategies">;
    eventType: "filled" | "rejected" | "cancelled" | "submission" | "intent" | "validation" | "fill_update";
    payload: string;
}[]>>;
export declare const getTradeHistory: import("convex/server").RegisteredQuery<"public", {
    limit?: number | undefined;
    runId?: import("convex/values").GenericId<"strategy_runs"> | undefined;
    strategyId?: import("convex/values").GenericId<"strategies"> | undefined;
    app?: "alpaca-options" | "polymarket" | "mt5" | "binance-futures" | undefined;
    eventTypes?: ("filled" | "rejected" | "cancelled" | "submission" | "intent" | "validation" | "fill_update")[] | undefined;
}, Promise<{
    _id: import("convex/values").GenericId<"trade_events">;
    _creationTime: number;
    app?: "alpaca-options" | "polymarket" | "mt5" | "binance-futures" | undefined;
    timestamp: number;
    runId: import("convex/values").GenericId<"strategy_runs">;
    strategyId: import("convex/values").GenericId<"strategies">;
    eventType: "filled" | "rejected" | "cancelled" | "submission" | "intent" | "validation" | "fill_update";
    payload: string;
}[]>>;
//# sourceMappingURL=orders.d.ts.map
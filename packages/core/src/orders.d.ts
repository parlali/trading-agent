import type { OrderIntent, ExecutionResult, Severity } from "./types";
export declare const ORDER_STATUSES: readonly ["pending", "partially_filled", "filled", "rejected", "cancelled", "expired", "timed_out"];
export type OrderStatus = typeof ORDER_STATUSES[number];
export declare const TERMINAL_ORDER_STATUSES: readonly OrderStatus[];
export declare const ACTIVE_ORDER_STATUSES: readonly OrderStatus[];
export declare const ORDER_ACTIONS: readonly ["entry", "adjustment", "close", "modify", "cancel"];
export type OrderAction = typeof ORDER_ACTIONS[number];
export declare const ORDER_TRANSITION_TYPES: readonly ["submission", "status_change", "modify_attempt", "cancel_attempt", "timeout_decision", "terminal"];
export type OrderTransitionType = typeof ORDER_TRANSITION_TYPES[number];
export interface OrderPollingMetadata {
    pollIntervalMs: number;
    timeoutMs: number;
    startedAt: number;
    lastCheckedAt: number;
    nextCheckAt?: number;
    timedOutAt?: number;
    lastError?: string;
    resumeToken?: string;
}
export interface OrderSnapshot {
    orderId: string;
    strategyId: string;
    runId: string;
    instrument: string;
    status: OrderStatus;
    action: OrderAction;
    quantity: number;
    filledQuantity: number;
    remainingQuantity: number;
    avgFillPrice?: number;
    submittedAt: number;
    updatedAt: number;
    venue: string;
    intent: OrderIntent;
    metadata?: Record<string, unknown>;
    polling: OrderPollingMetadata;
}
export interface OrderTransition {
    orderId: string;
    strategyId: string;
    runId: string;
    sequence: number;
    type: OrderTransitionType;
    status: OrderStatus;
    previousStatus?: OrderStatus;
    timestamp: number;
    reason?: string;
    details?: Record<string, unknown>;
}
export interface TrackedOrderHandle {
    orderId: string;
    action: OrderAction;
    snapshot: OrderSnapshot;
}
export interface WaitForOrderUpdateOptions {
    timeoutMs?: number;
}
export interface OrderUpdateDecision {
    decision: "wait" | "modify" | "cancel" | "proceed";
    reason?: string;
    changes?: Partial<OrderIntent>;
}
export interface OrderUpdateContext {
    handle: TrackedOrderHandle;
    previousSnapshot: OrderSnapshot;
    currentSnapshot: OrderSnapshot;
    transition: OrderTransition;
}
export interface OrderLifecycleAlert {
    strategyId: string;
    runId: string;
    orderId: string;
    severity: Severity;
    message: string;
    metadata?: Record<string, unknown>;
}
export interface OrderPersistenceAdapter {
    upsertOrder(snapshot: OrderSnapshot): Promise<void>;
    logOrderTransition(transition: OrderTransition): Promise<void>;
    getOrder(orderId: string): Promise<OrderSnapshot | null>;
    listActiveOrders(strategyId: string): Promise<OrderSnapshot[]>;
    createAlert?(alert: OrderLifecycleAlert): Promise<void>;
}
export interface ResumeTrackedOrderInput {
    snapshot: OrderSnapshot;
    action: OrderAction;
}
export declare const isTerminalOrderStatus: (status: OrderStatus) => boolean;
export declare const isActiveEntryOrderStatus: (status: OrderStatus) => boolean;
export declare const createOrderSnapshot: (params: {
    strategyId: string;
    runId: string;
    venue: string;
    action: OrderAction;
    intent: OrderIntent;
    result: ExecutionResult;
    pollIntervalMs: number;
    timeoutMs: number;
    now?: number;
    metadata?: Record<string, unknown>;
}) => OrderSnapshot;
export declare const updateOrderSnapshotFromExecution: (snapshot: OrderSnapshot, result: ExecutionResult, now?: number) => OrderSnapshot;
export declare const createTimedOutExecutionResult: (snapshot: OrderSnapshot, now?: number) => ExecutionResult;
export declare const restartOrderPollingWindow: (snapshot: OrderSnapshot, now?: number) => OrderSnapshot;
export declare const pauseOrderPollingForHandoff: (snapshot: OrderSnapshot, reason: string, now?: number) => OrderSnapshot;
//# sourceMappingURL=orders.d.ts.map
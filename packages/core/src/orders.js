import { createExecutionErrorDetail, formatExecutionError } from "./utils";
export const ORDER_STATUSES = [
    "pending",
    "partially_filled",
    "filled",
    "rejected",
    "cancelled",
    "expired",
    "timed_out",
];
export const TERMINAL_ORDER_STATUSES = [
    "filled",
    "rejected",
    "cancelled",
    "expired",
    "timed_out",
];
export const ACTIVE_ORDER_STATUSES = [
    "pending",
    "partially_filled",
];
export const ORDER_ACTIONS = [
    "entry",
    "adjustment",
    "close",
    "modify",
    "cancel",
];
export const ORDER_TRANSITION_TYPES = [
    "submission",
    "status_change",
    "modify_attempt",
    "cancel_attempt",
    "timeout_decision",
    "terminal",
];
export const isTerminalOrderStatus = (status) => {
    return TERMINAL_ORDER_STATUSES.includes(status);
};
export const isActiveEntryOrderStatus = (status) => {
    return ACTIVE_ORDER_STATUSES.includes(status);
};
export const createOrderSnapshot = (params) => {
    const timestamp = params.now ?? params.result.timestamp ?? Date.now();
    const filledQuantity = params.result.filledQuantity ?? 0;
    return {
        orderId: params.result.orderId,
        strategyId: params.strategyId,
        runId: params.runId,
        instrument: params.intent.instrument,
        status: params.result.status,
        action: params.action,
        quantity: params.intent.quantity,
        filledQuantity,
        remainingQuantity: Math.max(params.intent.quantity - filledQuantity, 0),
        avgFillPrice: params.result.fillPrice,
        submittedAt: timestamp,
        updatedAt: timestamp,
        venue: params.venue,
        intent: params.intent,
        metadata: params.metadata,
        polling: {
            pollIntervalMs: params.pollIntervalMs,
            timeoutMs: params.timeoutMs,
            startedAt: timestamp,
            lastCheckedAt: timestamp,
            nextCheckAt: timestamp + params.pollIntervalMs,
        },
    };
};
export const updateOrderSnapshotFromExecution = (snapshot, result, now) => {
    const timestamp = now ?? result.timestamp ?? Date.now();
    const nextIntent = mergeOrderIntent(snapshot.intent, result.intentUpdates);
    const nextQuantity = nextIntent.quantity;
    const filledQuantity = result.filledQuantity ?? snapshot.filledQuantity;
    return {
        ...snapshot,
        quantity: nextQuantity,
        status: result.status,
        filledQuantity,
        remainingQuantity: Math.max(nextQuantity - filledQuantity, 0),
        avgFillPrice: result.fillPrice ?? snapshot.avgFillPrice,
        intent: nextIntent,
        updatedAt: timestamp,
        polling: {
            ...snapshot.polling,
            lastCheckedAt: timestamp,
            nextCheckAt: isTerminalOrderStatus(result.status)
                ? undefined
                : timestamp + snapshot.polling.pollIntervalMs,
            timedOutAt: result.status === "timed_out" ? timestamp : snapshot.polling.timedOutAt,
            lastError: result.error ?? snapshot.polling.lastError,
        },
    };
};
export const createTimedOutExecutionResult = (snapshot, now = Date.now()) => {
    const errorDetail = createExecutionErrorDetail("timeout", "Order tracking timed out before reaching a terminal venue status", {
        code: "ORDER_TIMEOUT",
        retryable: true,
        details: {
            orderId: snapshot.orderId,
            timeoutMs: snapshot.polling.timeoutMs,
        },
    });
    return {
        orderId: snapshot.orderId,
        status: "timed_out",
        filledQuantity: snapshot.filledQuantity,
        fillPrice: snapshot.avgFillPrice,
        timestamp: now,
        error: formatExecutionError(errorDetail),
        errorDetail,
    };
};
export const restartOrderPollingWindow = (snapshot, now = Date.now()) => {
    return {
        ...snapshot,
        updatedAt: now,
        polling: {
            ...snapshot.polling,
            startedAt: now,
            lastCheckedAt: now,
            nextCheckAt: now + snapshot.polling.pollIntervalMs,
            timedOutAt: undefined,
        },
    };
};
export const pauseOrderPollingForHandoff = (snapshot, reason, now = Date.now()) => {
    return {
        ...snapshot,
        updatedAt: now,
        polling: {
            ...snapshot.polling,
            lastCheckedAt: now,
            nextCheckAt: undefined,
            timedOutAt: now,
            lastError: reason,
        },
    };
};
function mergeOrderIntent(intent, updates) {
    if (!updates) {
        return intent;
    }
    return {
        ...intent,
        ...updates,
        metadata: updates.metadata
            ? {
                ...intent.metadata,
                ...updates.metadata,
            }
            : intent.metadata,
    };
}

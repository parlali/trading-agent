import type { OrderIntent, ExecutionResult, Severity } from "./types"
import { createExecutionErrorDetail, formatExecutionError } from "./utils"

export const ORDER_STATUSES = [
    "pending",
    "partially_filled",
    "filled",
    "rejected",
    "cancelled",
    "expired",
    "timed_out",
] as const

export type OrderStatus = typeof ORDER_STATUSES[number]

export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = [
    "filled",
    "rejected",
    "cancelled",
    "expired",
    "timed_out",
]

export const ACTIVE_ORDER_STATUSES: readonly OrderStatus[] = [
    "pending",
    "partially_filled",
]

export const ORDER_ACTIONS = [
    "entry",
    "adjustment",
    "close",
    "modify",
    "cancel",
] as const

export type OrderAction = typeof ORDER_ACTIONS[number]

export const ORDER_TRANSITION_TYPES = [
    "submission",
    "status_change",
    "modify_attempt",
    "cancel_attempt",
    "timeout_decision",
    "terminal",
] as const

export type OrderTransitionType = typeof ORDER_TRANSITION_TYPES[number]

export interface OrderPollingMetadata {
    pollIntervalMs: number
    timeoutMs: number
    startedAt: number
    lastCheckedAt: number
    nextCheckAt?: number
    timedOutAt?: number
    lastError?: string
    resumeToken?: string
}

export interface OrderSnapshot {
    orderId: string
    strategyId: string
    runId: string
    instrument: string
    status: OrderStatus
    action: OrderAction
    quantity: number
    filledQuantity: number
    remainingQuantity: number
    avgFillPrice?: number
    submittedAt: number
    updatedAt: number
    venue: string
    intent: OrderIntent
    metadata?: Record<string, unknown>
    polling: OrderPollingMetadata
}

export interface OrderTransition {
    orderId: string
    strategyId: string
    runId: string
    sequence: number
    type: OrderTransitionType
    status: OrderStatus
    previousStatus?: OrderStatus
    timestamp: number
    reason?: string
    details?: Record<string, unknown>
}

export interface TrackedOrderHandle {
    orderId: string
    action: OrderAction
    snapshot: OrderSnapshot
}

export interface WaitForOrderUpdateOptions {
    timeoutMs?: number
}

export interface OrderUpdateDecision {
    decision: "wait" | "modify" | "cancel" | "proceed"
    reason?: string
    changes?: Partial<OrderIntent>
}

export interface OrderUpdateContext {
    handle: TrackedOrderHandle
    previousSnapshot: OrderSnapshot
    currentSnapshot: OrderSnapshot
    transition: OrderTransition
}

export interface OrderLifecycleAlert {
    strategyId: string
    runId: string
    orderId: string
    severity: Severity
    message: string
    metadata?: Record<string, unknown>
}

export interface OrderPersistenceAdapter {
    upsertOrder(snapshot: OrderSnapshot): Promise<void>
    logOrderTransition(transition: OrderTransition): Promise<void>
    getOrder(orderId: string): Promise<OrderSnapshot | null>
    listActiveOrders(strategyId: string): Promise<OrderSnapshot[]>
    createAlert?(alert: OrderLifecycleAlert): Promise<void>
}

export interface ResumeTrackedOrderInput {
    snapshot: OrderSnapshot
    action: OrderAction
}

export const isTerminalOrderStatus = (status: OrderStatus): boolean => {
    return TERMINAL_ORDER_STATUSES.includes(status)
}

export const isActiveEntryOrderStatus = (status: OrderStatus): boolean => {
    return ACTIVE_ORDER_STATUSES.includes(status)
}

export const createOrderSnapshot = (
    params: {
        strategyId: string
        runId: string
        venue: string
        action: OrderAction
        intent: OrderIntent
        result: ExecutionResult
        pollIntervalMs: number
        timeoutMs: number
        now?: number
        metadata?: Record<string, unknown>
    }
): OrderSnapshot => {
    const timestamp = params.now ?? params.result.timestamp ?? Date.now()
    const filledQuantity = params.result.filledQuantity ?? 0

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
    }
}

export const updateOrderSnapshotFromExecution = (
    snapshot: OrderSnapshot,
    result: ExecutionResult,
    now?: number
): OrderSnapshot => {
    const timestamp = now ?? result.timestamp ?? Date.now()
    const nextIntent = mergeOrderIntent(snapshot.intent, result.intentUpdates)
    const nextQuantity = nextIntent.quantity
    const filledQuantity = result.filledQuantity ?? snapshot.filledQuantity

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
    }
}

export const createTimedOutExecutionResult = (snapshot: OrderSnapshot, now: number = Date.now()): ExecutionResult => {
    const errorDetail = createExecutionErrorDetail(
        "timeout",
        "Order tracking timed out before reaching a terminal venue status",
        {
            code: "ORDER_TIMEOUT",
            retryable: true,
            details: {
                orderId: snapshot.orderId,
                timeoutMs: snapshot.polling.timeoutMs,
            },
        }
    )

    return {
        orderId: snapshot.orderId,
        status: "timed_out",
        filledQuantity: snapshot.filledQuantity,
        fillPrice: snapshot.avgFillPrice,
        timestamp: now,
        error: formatExecutionError(errorDetail),
        errorDetail,
    }
}

export const restartOrderPollingWindow = (
    snapshot: OrderSnapshot,
    now: number = Date.now()
): OrderSnapshot => {
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
    }
}

export const pauseOrderPollingForHandoff = (
    snapshot: OrderSnapshot,
    reason: string,
    now: number = Date.now()
): OrderSnapshot => {
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
    }
}

function mergeOrderIntent(
    intent: OrderIntent,
    updates?: Partial<OrderIntent>
): OrderIntent {
    if (!updates) {
        return intent
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
    }
}

import type { ExecutionResult, Severity } from "./types"
import type { OrderIntent } from "./order-intent-types"
import { createExecutionErrorDetail, formatExecutionError } from "./utils"
import {
    ACTIVE_ORDER_STATUSES,
    TERMINAL_ORDER_STATUSES,
    type OrderAction,
    type OrderStatus,
} from "./order-types"

export {
    ACTIVE_ORDER_STATUSES,
    ORDER_ACTIONS,
    ORDER_STATUSES,
    TERMINAL_ORDER_STATUSES,
} from "./order-types"
export type {
    OrderAction,
    OrderStatus,
} from "./order-types"

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
    providerOrderId: string
    providerOrderAliases: string[]
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
    lastTransitionSequence: number
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
    logOrderTransition(transition: OrderTransition): Promise<number>
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
        providerOrderId: params.result.orderId,
        providerOrderAliases: [],
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
        lastTransitionSequence: 0,
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
    const nextProviderOrderId = result.orderId || snapshot.providerOrderId || snapshot.orderId
    const providerOrderAliases = dedupeOrderIdentifiers([
        ...snapshot.providerOrderAliases,
        snapshot.providerOrderId !== snapshot.orderId ? snapshot.providerOrderId : undefined,
    ]).filter((orderId) => orderId !== nextProviderOrderId)

    return {
        ...snapshot,
        quantity: nextQuantity,
        status: result.status,
        providerOrderId: nextProviderOrderId,
        providerOrderAliases,
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

export const getOrderIdentityCandidates = (
    snapshot: Pick<OrderSnapshot, "orderId"> & Partial<Pick<OrderSnapshot, "providerOrderId" | "providerOrderAliases">>
): string[] => {
    return dedupeOrderIdentifiers([
        snapshot.orderId,
        snapshot.providerOrderId,
        ...(snapshot.providerOrderAliases ?? []),
    ])
}

export const matchesOrderIdentifier = (
    snapshot: Pick<OrderSnapshot, "orderId"> & Partial<Pick<OrderSnapshot, "providerOrderId" | "providerOrderAliases">>,
    orderId: string
): boolean => {
    return getOrderIdentityCandidates(snapshot).includes(orderId)
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

function dedupeOrderIdentifiers(orderIds: Array<string | undefined>): string[] {
    const seen = new Set<string>()

    for (const orderId of orderIds) {
        if (!orderId || orderId.trim().length === 0) {
            continue
        }

        seen.add(orderId)
    }

    return Array.from(seen)
}

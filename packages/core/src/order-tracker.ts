import type {
    ExecutionResult,
    OrderIntent,
} from "./types"
import {
    ACTIVE_ORDER_STATUSES,
    createOrderSnapshot,
    isTerminalOrderStatus,
    pauseOrderPollingForHandoff,
    restartOrderPollingWindow,
    updateOrderSnapshotFromExecution,
    type OrderAction,
    type OrderLifecycleAlert,
    type OrderPersistenceAdapter,
    type OrderSnapshot,
    type OrderTransition,
    type OrderUpdateDecision,
    type OrderUpdateContext,
    type TrackedOrderHandle,
    type WaitForOrderUpdateOptions,
} from "./orders"
import type { VenueAdapter, TradeEventLogger, OrderLifecycleConfig, OrderStatusCallback } from "./execution"
import type { Logger } from "./logger"
import { hasIntentChanges } from "./intent"

interface TrackedOrderState {
    handle: TrackedOrderHandle
    timer: ReturnType<typeof setTimeout> | null
    updateResolvers: Array<(snapshot: OrderSnapshot) => void>
    listener?: OrderStatusCallback
    transitionSequence: number
}

export class OrderLifecycleManager {
    private venue: VenueAdapter
    private logger: Logger
    private pollInterval: number
    private timeout: number
    private orderPersistence?: OrderPersistenceAdapter
    private tradeEventLogger?: TradeEventLogger
    private runId: string
    private strategyId: string
    private venueName: string
    private onSnapshotUpdate?: (previousSnapshot: OrderSnapshot, currentSnapshot: OrderSnapshot) => void
    private trackedOrders = new Map<string, TrackedOrderState>()

    constructor(
        venue: VenueAdapter,
        logger: Logger,
        config: OrderLifecycleConfig = {},
        orderPersistence?: OrderPersistenceAdapter,
        tradeEventLogger?: TradeEventLogger,
        runId: string = "",
        strategyId: string = "",
        venueName: string = "unknown",
        onSnapshotUpdate?: (previousSnapshot: OrderSnapshot, currentSnapshot: OrderSnapshot) => void
    ) {
        this.venue = venue
        this.logger = logger
        this.pollInterval = config.pollInterval ?? 5000
        this.timeout = config.timeout ?? 120_000
        this.orderPersistence = orderPersistence
        this.tradeEventLogger = tradeEventLogger
        this.runId = runId
        this.strategyId = strategyId
        this.venueName = venueName
        this.onSnapshotUpdate = onSnapshotUpdate
    }

    async registerSubmittedOrder(
        intent: OrderIntent,
        result: ExecutionResult,
        action: OrderAction,
        metadata?: Record<string, unknown>
    ): Promise<TrackedOrderHandle | undefined> {
        if (!result.orderId) {
            return undefined
        }

        const snapshot = createOrderSnapshot({
            strategyId: this.strategyId,
            runId: this.runId,
            venue: this.venueName,
            action,
            intent,
            result,
            pollIntervalMs: this.pollInterval,
            timeoutMs: this.timeout,
            metadata,
        })
        const handle: TrackedOrderHandle = {
            orderId: snapshot.orderId,
            action,
            snapshot,
        }

        const tracked: TrackedOrderState = {
            handle,
            timer: null,
            updateResolvers: [],
            transitionSequence: 0,
        }

        this.trackedOrders.set(snapshot.orderId, tracked)
        this.persistSnapshot(snapshot)
        this.persistTransition(tracked, {
            orderId: snapshot.orderId,
            strategyId: snapshot.strategyId,
            runId: snapshot.runId,
            sequence: 0,
            type: "submission",
            status: snapshot.status,
            timestamp: snapshot.submittedAt,
            details: {
                action,
                instrument: snapshot.instrument,
            },
        })

        if (!isTerminalOrderStatus(snapshot.status)) {
            this.schedulePoll(snapshot.orderId)
        }

        return handle
    }

    async waitForUpdate(
        orderId: string,
        onUpdate: OrderStatusCallback,
        options: WaitForOrderUpdateOptions = {}
    ): Promise<OrderSnapshot> {
        const tracked = await this.requireTrackedOrder(orderId)
        tracked.listener = onUpdate

        if (isTerminalOrderStatus(tracked.handle.snapshot.status)) {
            return tracked.handle.snapshot
        }

        const timeoutMs = options.timeoutMs ?? this.timeout

        return new Promise((resolve) => {
            const timeoutId = setTimeout(() => {
                tracked.updateResolvers = tracked.updateResolvers.filter((entry) => entry !== resolver)
                resolve(tracked.handle.snapshot)
            }, timeoutMs)

            const resolver = (snapshot: OrderSnapshot) => {
                clearTimeout(timeoutId)
                resolve(snapshot)
            }

            tracked.updateResolvers.push(resolver)
        })
    }

    async resumeActiveOrders(onUpdate: OrderStatusCallback): Promise<OrderSnapshot[]> {
        if (!this.orderPersistence) {
            return []
        }

        const snapshots = await this.orderPersistence.listActiveOrders(this.strategyId)
        const resumedSnapshots: OrderSnapshot[] = []

        for (const snapshot of snapshots) {
            if (!ACTIVE_ORDER_STATUSES.includes(snapshot.status)) {
                continue
            }

            const resumedSnapshot = restartOrderPollingWindow(snapshot)
            const existingTracked = this.trackedOrders.get(resumedSnapshot.orderId)
            if (existingTracked?.timer) {
                clearTimeout(existingTracked.timer)
            }

            const tracked: TrackedOrderState = {
                handle: {
                    orderId: resumedSnapshot.orderId,
                    action: resumedSnapshot.action,
                    snapshot: resumedSnapshot,
                },
                timer: null,
                updateResolvers: [],
                listener: onUpdate,
                transitionSequence: existingTracked?.transitionSequence ?? 0,
            }

            this.trackedOrders.set(resumedSnapshot.orderId, tracked)
            this.persistSnapshot(resumedSnapshot)
            this.schedulePoll(resumedSnapshot.orderId)
            resumedSnapshots.push(resumedSnapshot)
        }

        return resumedSnapshots
    }

    getTrackedSnapshot(orderId: string): OrderSnapshot | null {
        return this.trackedOrders.get(orderId)?.handle.snapshot ?? null
    }

    getTrackedOrders(): OrderSnapshot[] {
        return Array.from(this.trackedOrders.values()).map((tracked) => tracked.handle.snapshot)
    }

    async getOrderSnapshot(orderId: string): Promise<OrderSnapshot | null> {
        const tracked = this.trackedOrders.get(orderId)?.handle.snapshot
        if (tracked) {
            return tracked
        }

        return this.orderPersistence?.getOrder(orderId) ?? null
    }

    async recordModifyAttempt(orderId: string, changes: Partial<OrderIntent>, reason?: string): Promise<void> {
        const tracked = await this.requireTrackedOrder(orderId)
        this.persistTransition(tracked, {
            orderId,
            strategyId: tracked.handle.snapshot.strategyId,
            runId: tracked.handle.snapshot.runId,
            sequence: 0,
            type: "modify_attempt",
            status: tracked.handle.snapshot.status,
            previousStatus: tracked.handle.snapshot.status,
            timestamp: Date.now(),
            reason,
            details: changes as Record<string, unknown>,
        })
    }

    async recordCancelAttempt(orderId: string, reason?: string): Promise<void> {
        const tracked = await this.requireTrackedOrder(orderId)
        this.persistTransition(tracked, {
            orderId,
            strategyId: tracked.handle.snapshot.strategyId,
            runId: tracked.handle.snapshot.runId,
            sequence: 0,
            type: "cancel_attempt",
            status: tracked.handle.snapshot.status,
            previousStatus: tracked.handle.snapshot.status,
            timestamp: Date.now(),
            reason,
        })
    }

    async captureVenueUpdate(
        orderId: string,
        result: ExecutionResult,
        transitionType: "status_change" | "modify_attempt" | "cancel_attempt",
        reason?: string
    ): Promise<OrderSnapshot> {
        const tracked = await this.requireTrackedOrder(orderId)
        return this.applyExecutionResult(tracked, result, transitionType, reason)
    }

    stopTracking(orderId: string): void {
        const tracked = this.trackedOrders.get(orderId)
        if (!tracked) {
            return
        }

        if (tracked.timer) {
            clearTimeout(tracked.timer)
        }

        this.trackedOrders.delete(orderId)
        this.logger.info("Stopped tracking order", { orderId })
    }

    stopAll(): void {
        for (const orderId of this.trackedOrders.keys()) {
            this.stopTracking(orderId)
        }
    }

    private schedulePoll(orderId: string): void {
        const tracked = this.trackedOrders.get(orderId)
        if (!tracked) {
            return
        }

        if (tracked.timer) {
            clearTimeout(tracked.timer)
        }

        tracked.timer = setTimeout(() => {
            void this.pollOrder(orderId)
        }, this.pollInterval)
    }

    private async pollOrder(orderId: string): Promise<void> {
        const tracked = this.trackedOrders.get(orderId)
        if (!tracked) {
            return
        }

        try {
            const elapsed = Date.now() - tracked.handle.snapshot.polling.startedAt

            if (elapsed > tracked.handle.snapshot.polling.timeoutMs) {
                const timeoutReason = "Order wait budget expired for this run; carrying active venue order forward to the next run"
                const previousSnapshot = tracked.handle.snapshot
                const latestVenueResult = await this.fetchOrderStatusOnTimeout(tracked.handle.orderId)

                if (latestVenueResult && isTerminalOrderStatus(latestVenueResult.status)) {
                    await this.applyExecutionResult(tracked, latestVenueResult, "terminal", timeoutReason)
                    return
                }

                const refreshedSnapshot = latestVenueResult
                    ? updateOrderSnapshotFromExecution(previousSnapshot, latestVenueResult)
                    : previousSnapshot
                const handoffSnapshot = pauseOrderPollingForHandoff(refreshedSnapshot, timeoutReason)

                tracked.handle = {
                    ...tracked.handle,
                    snapshot: handoffSnapshot,
                }
                this.persistSnapshot(handoffSnapshot)
                this.persistTransition(tracked, {
                    orderId: handoffSnapshot.orderId,
                    strategyId: handoffSnapshot.strategyId,
                    runId: handoffSnapshot.runId,
                    sequence: 0,
                    type: "timeout_decision",
                    status: handoffSnapshot.status,
                    previousStatus: previousSnapshot.status,
                    timestamp: handoffSnapshot.updatedAt,
                    reason: timeoutReason,
                })
                this.createAlert({
                    strategyId: handoffSnapshot.strategyId,
                    runId: handoffSnapshot.runId,
                    orderId: handoffSnapshot.orderId,
                    severity: "warning",
                    message: `Order ${handoffSnapshot.orderId} remained live after this run's wait window and will be resumed next run`,
                    metadata: {
                        instrument: handoffSnapshot.instrument,
                    },
                })
                this.resolvePendingWaiters(tracked, handoffSnapshot)
                this.stopTracking(orderId)
                return
            }

            const result = await this.venue.getOrderStatus(orderId)
            await this.applyExecutionResult(tracked, result, "status_change")
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            const snapshot = {
                ...tracked.handle.snapshot,
                polling: {
                    ...tracked.handle.snapshot.polling,
                    lastCheckedAt: Date.now(),
                    nextCheckAt: Date.now() + tracked.handle.snapshot.polling.pollIntervalMs,
                    lastError: message,
                },
            }

            tracked.handle = {
                ...tracked.handle,
                snapshot,
            }
            this.persistSnapshot(snapshot)
            this.logger.error("Error polling order status", { orderId, error: message })
            this.createAlert({
                strategyId: snapshot.strategyId,
                runId: snapshot.runId,
                orderId,
                severity: "warning",
                message: `Order status polling failed for ${orderId}: ${message}`,
            })
            this.schedulePoll(orderId)
        }
    }

    private async applyExecutionResult(
        tracked: TrackedOrderState,
        result: ExecutionResult,
        transitionType: "status_change" | "modify_attempt" | "cancel_attempt" | "terminal",
        reason?: string
    ): Promise<OrderSnapshot> {
        const previousSnapshot = tracked.handle.snapshot
        const updatedSnapshot = updateOrderSnapshotFromExecution(previousSnapshot, result)
        this.onSnapshotUpdate?.(previousSnapshot, updatedSnapshot)
        tracked.handle = {
            ...tracked.handle,
            snapshot: updatedSnapshot,
        }

        this.persistSnapshot(updatedSnapshot)

        const transition: OrderTransition = {
            orderId: updatedSnapshot.orderId,
            strategyId: updatedSnapshot.strategyId,
            runId: updatedSnapshot.runId,
            sequence: 0,
            type: isTerminalOrderStatus(updatedSnapshot.status) ? "terminal" : transitionType,
            status: updatedSnapshot.status,
            previousStatus: previousSnapshot.status,
            timestamp: updatedSnapshot.updatedAt,
            reason,
            details: result.error
                ? {
                    error: result.error,
                    errorDetail: result.errorDetail,
                }
                : undefined,
        }

        this.persistTransition(tracked, transition)
        if (
            previousSnapshot.status !== updatedSnapshot.status ||
            previousSnapshot.filledQuantity !== updatedSnapshot.filledQuantity
        ) {
            void this.tradeEventLogger?.logFillUpdate(this.runId, this.strategyId, result)
        }

        if (previousSnapshot.status !== updatedSnapshot.status || previousSnapshot.filledQuantity !== updatedSnapshot.filledQuantity) {
            this.logger.info("Order status update", {
                orderId: updatedSnapshot.orderId,
                status: updatedSnapshot.status,
                filledQuantity: updatedSnapshot.filledQuantity,
            })

            const decision = await tracked.listener?.({
                handle: tracked.handle,
                previousSnapshot,
                currentSnapshot: updatedSnapshot,
                transition,
            })

            if (decision) {
                await this.handleDecision(tracked, decision)
            }

            this.resolvePendingWaiters(tracked, updatedSnapshot)
        }

        if (isTerminalOrderStatus(updatedSnapshot.status)) {
            this.stopTracking(updatedSnapshot.orderId)
        } else {
            this.schedulePoll(updatedSnapshot.orderId)
        }

        return updatedSnapshot
    }

    private async handleDecision(tracked: TrackedOrderState, decision: OrderUpdateDecision): Promise<void> {
        if (decision.decision === "wait" || decision.decision === "proceed") {
            return
        }

        if (decision.decision === "modify") {
            if (!decision.changes || !hasIntentChanges(decision.changes)) {
                return
            }

            await this.recordModifyAttempt(tracked.handle.orderId, decision.changes, decision.reason)
            const result = await this.venue.modifyOrder(tracked.handle.orderId, decision.changes)
            await this.applyExecutionResult(tracked, result, "modify_attempt", decision.reason)
            return
        }

        await this.recordCancelAttempt(tracked.handle.orderId, decision.reason)
        const result = await this.venue.cancelOrder(tracked.handle.orderId)
        await this.applyExecutionResult(tracked, result, "cancel_attempt", decision.reason)
    }

    private persistSnapshot(snapshot: OrderSnapshot): void {
        void this.orderPersistence?.upsertOrder(snapshot)
    }

    private persistTransition(tracked: TrackedOrderState, transition: OrderTransition): void {
        tracked.transitionSequence += 1
        void this.orderPersistence?.logOrderTransition({
            ...transition,
            sequence: tracked.transitionSequence,
        })
    }

    private resolvePendingWaiters(tracked: TrackedOrderState, snapshot: OrderSnapshot): void {
        const waiters = tracked.updateResolvers
        tracked.updateResolvers = []

        for (const resolve of waiters) {
            resolve(snapshot)
        }
    }

    private async requireTrackedOrder(orderId: string): Promise<TrackedOrderState> {
        const existing = this.trackedOrders.get(orderId)
        if (existing) {
            return existing
        }

        const snapshot = await this.orderPersistence?.getOrder(orderId)
        if (!snapshot) {
            throw new Error(`Order ${orderId} is not being tracked`)
        }

        const tracked: TrackedOrderState = {
            handle: {
                orderId,
                action: snapshot.action,
                snapshot,
            },
            timer: null,
            updateResolvers: [],
            transitionSequence: 0,
        }

        this.trackedOrders.set(orderId, tracked)
        return tracked
    }

    private createAlert(alert: OrderLifecycleAlert): void {
        void this.orderPersistence?.createAlert?.(alert)
    }

    private async fetchOrderStatusOnTimeout(orderId: string): Promise<ExecutionResult | null> {
        try {
            return await this.venue.getOrderStatus(orderId)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            this.logger.warn("Failed to refresh order status at timeout boundary", {
                orderId,
                error: message,
            })
            return null
        }
    }
}

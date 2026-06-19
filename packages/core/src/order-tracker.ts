import type {
    ExecutionResult,
    OrderIntent,
} from "./types"
import {
    ACTIVE_ORDER_STATUSES,
    createOrderSnapshot,
    matchesOrderIdentifier,
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
import type {
    ExecutionOrderOperation,
    ExecutionOrderOperationLock,
    VenueAdapter,
    TradeEventLogger,
    OrderLifecycleConfig,
    OrderOperationContext,
    OrderStatusCallback,
} from "./execution-contracts"
import type { Logger } from "./logger"
import { hasIntentChanges } from "./intent"
import { toRecoverableOperationResult } from "./execution-result-helpers"

interface TrackedOrderState {
    handle: TrackedOrderHandle
    timer: ReturnType<typeof setTimeout> | null
    updateResolvers: Array<(snapshot: OrderSnapshot) => void>
    listener?: OrderStatusCallback
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
    private accountId?: string
    private venueName: string
    private onSnapshotUpdate?: (previousSnapshot: OrderSnapshot, currentSnapshot: OrderSnapshot) => void
    private orderOperationLock?: ExecutionOrderOperationLock
    private trackedOrders = new Map<string, TrackedOrderState>()

    constructor(
        venue: VenueAdapter,
        logger: Logger,
        config: OrderLifecycleConfig = {},
        orderPersistence?: OrderPersistenceAdapter,
        tradeEventLogger?: TradeEventLogger,
        runId: string = "",
        strategyId: string = "",
        accountId: string | undefined = undefined,
        venueName: string = "unknown",
        onSnapshotUpdate?: (previousSnapshot: OrderSnapshot, currentSnapshot: OrderSnapshot) => void,
        orderOperationLock?: ExecutionOrderOperationLock
    ) {
        this.venue = venue
        this.logger = logger
        this.pollInterval = config.pollInterval ?? 5000
        this.timeout = config.timeout ?? 120_000
        this.orderPersistence = orderPersistence
        this.tradeEventLogger = tradeEventLogger
        this.runId = runId
        this.strategyId = strategyId
        this.accountId = accountId
        this.venueName = venueName
        this.onSnapshotUpdate = onSnapshotUpdate
        this.orderOperationLock = orderOperationLock
    }

    async registerSubmittedOrder(
        intent: OrderIntent,
        result: ExecutionResult,
        action: OrderAction,
        metadata?: Record<string, unknown>
    ): Promise<TrackedOrderHandle | undefined> {
        const snapshot = createOrderSnapshot({
            strategyId: this.strategyId,
            runId: this.runId,
            accountId: this.accountId,
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
        }

        this.trackedOrders.set(snapshot.orderId, tracked)
        await this.persistSnapshot(snapshot)
        await this.persistTransition(tracked, {
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
                providerOrderId: snapshot.providerOrderId,
                providerClientOrderId: snapshot.providerClientOrderId,
                commitOutcome: snapshot.commitOutcome,
            },
        })

        if (shouldPollSnapshot(snapshot)) {
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
            }

            this.trackedOrders.set(resumedSnapshot.orderId, tracked)
            await this.persistSnapshot(resumedSnapshot)
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
        const tracked = this.findTrackedOrder(orderId)
        if (!tracked) {
            return
        }

        if (tracked.timer) {
            clearTimeout(tracked.timer)
        }

        this.trackedOrders.delete(tracked.handle.snapshot.orderId)
        this.logger.info("Stopped tracking order", {
            orderId: tracked.handle.snapshot.orderId,
            providerOrderId: tracked.handle.snapshot.providerOrderId,
        })
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
        await this.runOrderOperation("pollOrderStatus", async () =>
            await this.pollOrderWithoutOperationLock(orderId)
        )
    }

    private async pollOrderWithoutOperationLock(orderId: string): Promise<void> {
        const tracked = this.trackedOrders.get(orderId)
        if (!tracked) {
            return
        }

        try {
            const elapsed = Date.now() - tracked.handle.snapshot.polling.startedAt

            if (elapsed > tracked.handle.snapshot.polling.timeoutMs) {
                const timeoutReason = "Order wait budget expired for this run; carrying active venue order forward to the next run"
                const previousSnapshot = tracked.handle.snapshot
                const latestVenueResult = await this.fetchOrderStatusOnTimeout(tracked.handle.snapshot.providerOrderId)

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
                    orderId: handoffSnapshot.orderId,
                    snapshot: handoffSnapshot,
                }
                await this.persistSnapshot(handoffSnapshot)
                await this.persistTransition(tracked, {
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

            const providerOrderId = tracked.handle.snapshot.providerOrderId
            if (!providerOrderId) {
                return
            }

            const result = await this.venue.getOrderStatus(providerOrderId)
            await this.applyExecutionResult(tracked, result, "status_change")
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            const previousError = tracked.handle.snapshot.polling.lastError
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
                orderId: snapshot.orderId,
                snapshot,
            }
            await this.persistSnapshot(snapshot)
            this.logger.error("Error polling order status", { orderId, error: message })
            if (previousError === undefined) {
                this.createAlert({
                    strategyId: snapshot.strategyId,
                    runId: snapshot.runId,
                    orderId,
                    severity: "warning",
                    message: `Order status polling failed for ${orderId}: ${message}`,
                })
            }
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
            orderId: updatedSnapshot.orderId,
            snapshot: updatedSnapshot,
        }

        await this.persistSnapshot(updatedSnapshot)

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
            details: buildTransitionDetails(previousSnapshot, updatedSnapshot, result),
        }

        await this.persistTransition(tracked, transition)

        if (previousSnapshot.status !== updatedSnapshot.status || previousSnapshot.filledQuantity !== updatedSnapshot.filledQuantity) {
            void this.tradeEventLogger?.logFillUpdate(this.runId, this.strategyId, result)
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
        } else if (shouldPollSnapshot(updatedSnapshot)) {
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

            await this.recordModifyAttempt(tracked.handle.snapshot.orderId, decision.changes, decision.reason)
            const result = await this.venue.modifyOrder(
                tracked.handle.snapshot.providerOrderId,
                decision.changes,
                createOrderOperationContext(tracked.handle.snapshot)
            )
            await this.applyExecutionResult(tracked, toRecoverableOperationResult(result), "modify_attempt", decision.reason)
            return
        }

        await this.recordCancelAttempt(tracked.handle.snapshot.orderId, decision.reason)
        const result = await this.venue.cancelOrder(
            tracked.handle.snapshot.providerOrderId,
            createOrderOperationContext(tracked.handle.snapshot)
        )
        await this.applyExecutionResult(tracked, toRecoverableOperationResult(result), "cancel_attempt", decision.reason)
    }

    private async persistSnapshot(snapshot: OrderSnapshot): Promise<void> {
        await this.orderPersistence?.upsertOrder(snapshot)
    }

    private async persistTransition(tracked: TrackedOrderState, transition: OrderTransition): Promise<void> {
        const sequence = await this.orderPersistence?.logOrderTransition({
            ...transition,
            sequence: tracked.handle.snapshot.lastTransitionSequence + 1,
        })

        if (sequence === undefined) {
            return
        }

        tracked.handle = {
            ...tracked.handle,
            snapshot: {
                ...tracked.handle.snapshot,
                lastTransitionSequence: sequence,
            },
        }
    }

    private resolvePendingWaiters(tracked: TrackedOrderState, snapshot: OrderSnapshot): void {
        const waiters = tracked.updateResolvers
        tracked.updateResolvers = []

        for (const resolve of waiters) {
            resolve(snapshot)
        }
    }

    private async requireTrackedOrder(orderId: string): Promise<TrackedOrderState> {
        const existing = this.findTrackedOrder(orderId)
        if (existing) {
            return existing
        }

        const snapshot = await this.orderPersistence?.getOrder(orderId)
        if (!snapshot) {
            throw new Error(`Order ${orderId} is not being tracked`)
        }

        const tracked: TrackedOrderState = {
            handle: {
                orderId: snapshot.orderId,
                action: snapshot.action,
                snapshot,
            },
            timer: null,
            updateResolvers: [],
        }

        this.trackedOrders.set(snapshot.orderId, tracked)
        if (shouldPollSnapshot(snapshot)) {
            this.schedulePoll(snapshot.orderId)
        }
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

    private async runOrderOperation<T>(
        operation: ExecutionOrderOperation,
        run: () => Promise<T>
    ): Promise<T> {
        return this.orderOperationLock
            ? await this.orderOperationLock(operation, run)
            : await run()
    }

    private findTrackedOrder(orderId: string): TrackedOrderState | undefined {
        const direct = this.trackedOrders.get(orderId)
        if (direct) {
            return direct
        }

        return Array.from(this.trackedOrders.values()).find((tracked) =>
            matchesOrderIdentifier(tracked.handle.snapshot, orderId)
        )
    }
}

function createOrderOperationContext(snapshot: OrderSnapshot): OrderOperationContext {
    return {
        canonicalOrderId: snapshot.orderId,
        providerOrderId: snapshot.providerOrderId,
        providerClientOrderId: snapshot.providerClientOrderId,
        providerOrderAliases: snapshot.providerOrderAliases,
        signedOrderFingerprint: snapshot.signedOrderFingerprint,
    }
}

function buildTransitionDetails(
    previousSnapshot: OrderSnapshot,
    updatedSnapshot: OrderSnapshot,
    result: ExecutionResult
): Record<string, unknown> | undefined {
    const details: Record<string, unknown> = {}

    if (previousSnapshot.providerOrderId !== updatedSnapshot.providerOrderId) {
        details.previousProviderOrderId = previousSnapshot.providerOrderId
        details.providerOrderId = updatedSnapshot.providerOrderId
    }

    if (previousSnapshot.providerClientOrderId !== updatedSnapshot.providerClientOrderId) {
        details.previousProviderClientOrderId = previousSnapshot.providerClientOrderId
        details.providerClientOrderId = updatedSnapshot.providerClientOrderId
    }

    if (previousSnapshot.commitOutcome !== updatedSnapshot.commitOutcome) {
        details.previousCommitOutcome = previousSnapshot.commitOutcome
        details.commitOutcome = updatedSnapshot.commitOutcome
    }

    if (result.error) {
        details.error = result.error
        details.errorDetail = result.errorDetail
    }

    return Object.keys(details).length > 0 ? details : undefined
}

function shouldPollSnapshot(snapshot: OrderSnapshot): boolean {
    return !isTerminalOrderStatus(snapshot.status) &&
        snapshot.providerOrderId.trim().length > 0
}

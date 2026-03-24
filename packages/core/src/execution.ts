import type {
    AccountState,
    ExecutionResult,
    OrderIntent,
    OrderLifecycleContext,
    Position,
    ValidationResult,
} from "./types"
import {
    ACTIVE_ORDER_STATUSES,
    createOrderSnapshot,
    createTimedOutExecutionResult,
    isTerminalOrderStatus,
    type OrderAction,
    type OrderLifecycleAlert,
    type OrderPersistenceAdapter,
    type OrderSnapshot,
    type OrderTransition,
    type OrderUpdateDecision,
    type OrderUpdateContext,
    type TrackedOrderHandle,
    type WaitForOrderUpdateOptions,
    updateOrderSnapshotFromExecution,
} from "./orders"
import { BASE_RISK_VALIDATORS, type RiskValidator, validateIntent } from "./risk"
import type { Logger } from "./logger"

export interface VenueAdapter {
    getPositions(): Promise<Position[]>
    getAccountState(): Promise<AccountState>
    submitOrder(intent: OrderIntent): Promise<ExecutionResult>
    cancelOrder(orderId: string): Promise<ExecutionResult>
    modifyOrder(orderId: string, changes: Partial<OrderIntent>): Promise<ExecutionResult>
    closePosition(instrument: string): Promise<ExecutionResult>
    getOrderStatus(orderId: string): Promise<ExecutionResult>
}

export interface TradeEventLogger {
    logIntent(runId: string, strategyId: string, intent: OrderIntent): Promise<void>
    logValidation(runId: string, strategyId: string, result: ValidationResult, intent: OrderIntent): Promise<void>
    logSubmission(runId: string, strategyId: string, result: ExecutionResult, intent: OrderIntent): Promise<void>
    logFillUpdate(runId: string, strategyId: string, result: ExecutionResult): Promise<void>
}

export interface ExecutionPipelineConfig {
    venue: VenueAdapter
    venueName: string
    policy: Record<string, unknown>
    riskValidators?: readonly RiskValidator[]
    logger: Logger
    tradeEventLogger?: TradeEventLogger
    orderPersistence?: OrderPersistenceAdapter
    runId: string
    strategyId: string
    lifecycle?: OrderLifecycleConfig
}

export interface ExecuteIntentResult {
    result: ExecutionResult
    validation: ValidationResult
    handle?: TrackedOrderHandle
}

export interface OrderLifecycleConfig {
    pollInterval?: number
    timeout?: number
}

export type OrderStatusCallback = (
    update: OrderUpdateContext
) => OrderUpdateDecision | void | Promise<OrderUpdateDecision | void>

const ALLOWED_VALIDATION: ValidationResult = { allowed: true }

const getIntentAction = (intent: OrderIntent, fallback: OrderAction = "entry"): OrderAction => {
    const action = intent.metadata?.action

    if (action === "entry" || action === "adjustment" || action === "close" || action === "modify" || action === "cancel") {
        return action
    }

    if (action === "close_position") {
        return "close"
    }

    if (action === "modify_order") {
        return "modify"
    }

    if (action === "cancel_order") {
        return "cancel"
    }

    return fallback
}

const hasIntentChanges = (changes: Partial<OrderIntent>): boolean => {
    return Object.values(changes).some((value) => value !== undefined)
}

const createSyntheticIntent = (
    action: OrderAction,
    instrument: string,
    side: "buy" | "sell",
    quantity: number,
    orderId?: string,
    metadata?: Record<string, unknown>
): OrderIntent => {
    return {
        instrument,
        side,
        quantity,
        orderType: "market",
        timeInForce: "day",
        metadata: {
            action,
            orderId,
            ...metadata,
        },
    }
}

export class ExecutionPipeline {
    private venue: VenueAdapter
    private venueName: string
    private policy: Record<string, unknown>
    private riskValidators: readonly RiskValidator[]
    private logger: Logger
    private tradeEventLogger?: TradeEventLogger
    private lifecycleManager: OrderLifecycleManager
    private runId: string
    private strategyId: string

    constructor(config: ExecutionPipelineConfig) {
        this.venue = config.venue
        this.venueName = config.venueName
        this.policy = config.policy
        this.riskValidators = config.riskValidators ?? BASE_RISK_VALIDATORS
        this.logger = config.logger
        this.tradeEventLogger = config.tradeEventLogger
        this.runId = config.runId
        this.strategyId = config.strategyId
        this.lifecycleManager = new OrderLifecycleManager(
            config.venue,
            config.logger,
            config.lifecycle,
            config.orderPersistence,
            config.tradeEventLogger,
            config.runId,
            config.strategyId,
            config.venueName
        )
    }

    async executeIntent(
        intent: OrderIntent,
        accountState: AccountState,
        positions: Position[],
        lifecycleContext: OrderLifecycleContext = { action: getIntentAction(intent) }
    ): Promise<ExecuteIntentResult> {
        this.logger.info("Order intent received", { intent, action: lifecycleContext.action })
        await this.tradeEventLogger?.logIntent(this.runId, this.strategyId, intent)

        const validation = validateIntent(
            intent,
            this.policy,
            accountState,
            positions,
            this.riskValidators
        )
        await this.tradeEventLogger?.logValidation(this.runId, this.strategyId, validation, intent)

        if (!validation.allowed) {
            this.logger.warn("Order rejected by risk engine", { reason: validation.reason, intent })
            const rejectedResult: ExecutionResult = {
                orderId: "",
                status: "rejected",
                filledQuantity: 0,
                timestamp: Date.now(),
                error: validation.reason,
            }
            return { result: rejectedResult, validation }
        }

        const finalIntent = validation.adjustedIntent ?? intent

        if (this.policy.dryRun) {
            this.logger.info("Dry run -- order simulated", { intent: finalIntent })
            const mockResult: ExecutionResult = {
                orderId: `dry-run-${Date.now()}`,
                status: "filled",
                filledQuantity: finalIntent.quantity,
                fillPrice: finalIntent.limitPrice ?? 0,
                timestamp: Date.now(),
            }
            await this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, mockResult, finalIntent)
            const handle = await this.lifecycleManager.registerSubmittedOrder(
                finalIntent,
                mockResult,
                lifecycleContext.action,
                lifecycleContext.metadata
            )
            return { result: mockResult, validation, handle }
        }

        try {
            const result = await this.venue.submitOrder(finalIntent)
            this.logger.info("Order submitted", { orderId: result.orderId, status: result.status })
            await this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, result, finalIntent)
            const handle = await this.lifecycleManager.registerSubmittedOrder(
                finalIntent,
                result,
                lifecycleContext.action,
                lifecycleContext.metadata
            )
            return { result, validation, handle }
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error)
            this.logger.error("Order submission failed", { error: errorMsg, intent: finalIntent })
            const failedResult: ExecutionResult = {
                orderId: "",
                status: "rejected",
                filledQuantity: 0,
                timestamp: Date.now(),
                error: errorMsg,
            }
            await this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, failedResult, finalIntent)
            return { result: failedResult, validation }
        }
    }

    async cancelOrder(orderId: string, reason?: string): Promise<ExecutionResult> {
        const existing = await this.lifecycleManager.getOrderSnapshot(orderId)
        const instrument = existing?.instrument ?? "order-cancel"
        const intent = createSyntheticIntent("cancel", instrument, "sell", 0, orderId, { reason })

        this.logger.info("Cancelling order", { orderId, reason })
        await this.tradeEventLogger?.logIntent(this.runId, this.strategyId, intent)
        await this.tradeEventLogger?.logValidation(this.runId, this.strategyId, ALLOWED_VALIDATION, intent)

        if (this.policy.dryRun) {
            const result: ExecutionResult = {
                orderId,
                status: "cancelled",
                filledQuantity: existing?.filledQuantity ?? 0,
                fillPrice: existing?.avgFillPrice,
                timestamp: Date.now(),
            }
            await this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, result, intent)
            await this.lifecycleManager.recordCancelAttempt(orderId, reason)
            await this.lifecycleManager.captureVenueUpdate(orderId, result, "cancel_attempt", reason)
            return result
        }

        await this.lifecycleManager.recordCancelAttempt(orderId, reason)
        const result = await this.venue.cancelOrder(orderId)
        await this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, result, intent)
        await this.lifecycleManager.captureVenueUpdate(orderId, result, "cancel_attempt", reason)
        return result
    }

    async modifyOrder(orderId: string, changes: Partial<OrderIntent>, reason?: string): Promise<ExecutionResult> {
        const hasChanges = hasIntentChanges(changes)
        const existing = await this.lifecycleManager.getOrderSnapshot(orderId)
        const instrument = existing?.instrument ?? "order-modify"
        const side = existing?.intent.side ?? "buy"
        const intent: OrderIntent = {
            instrument,
            side,
            quantity: changes.quantity ?? existing?.quantity ?? 0,
            orderType: changes.orderType ?? existing?.intent.orderType ?? "limit",
            limitPrice: changes.limitPrice,
            stopPrice: changes.stopPrice,
            timeInForce: changes.timeInForce ?? existing?.intent.timeInForce ?? "day",
            legs: changes.legs,
            metadata: {
                action: "modify",
                orderId,
                reason,
            },
        }

        this.logger.info("Modifying order", { orderId, changes, reason })
        await this.tradeEventLogger?.logIntent(this.runId, this.strategyId, intent)

        if (!hasChanges) {
            const validation: ValidationResult = {
                allowed: false,
                reason: "At least one order modification must be provided",
            }
            await this.tradeEventLogger?.logValidation(this.runId, this.strategyId, validation, intent)

            return {
                orderId,
                status: "rejected",
                filledQuantity: existing?.filledQuantity ?? 0,
                fillPrice: existing?.avgFillPrice,
                timestamp: Date.now(),
                error: validation.reason,
            }
        }

        await this.tradeEventLogger?.logValidation(this.runId, this.strategyId, ALLOWED_VALIDATION, intent)
        await this.lifecycleManager.recordModifyAttempt(orderId, changes, reason)

        if (this.policy.dryRun) {
            const result: ExecutionResult = {
                orderId,
                status: existing?.status ?? "pending",
                filledQuantity: existing?.filledQuantity ?? 0,
                fillPrice: existing?.avgFillPrice,
                timestamp: Date.now(),
            }
            await this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, result, intent)
            await this.lifecycleManager.captureVenueUpdate(orderId, result, "modify_attempt", reason)
            return result
        }

        const result = await this.venue.modifyOrder(orderId, changes)
        await this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, result, intent)
        await this.lifecycleManager.captureVenueUpdate(orderId, result, "modify_attempt", reason)
        return result
    }

    async closePosition(instrument: string, reason?: string): Promise<ExecuteIntentResult> {
        const positions = await this.venue.getPositions()
        const position = positions.find((item) => item.instrument === instrument)
        const closeSide = position?.side === "long" ? "sell" : "buy"
        const intent: OrderIntent = {
            instrument,
            side: closeSide,
            quantity: position?.quantity ?? 0,
            orderType: "market",
            timeInForce: "day",
            metadata: {
                action: "close",
                reason,
            },
        }

        this.logger.info("Closing position", { instrument, reason })
        await this.tradeEventLogger?.logIntent(this.runId, this.strategyId, intent)

        if (!position) {
            const validation: ValidationResult = {
                allowed: false,
                reason: `No open position found for ${instrument}`,
            }
            await this.tradeEventLogger?.logValidation(this.runId, this.strategyId, validation, intent)

            return {
                result: {
                    orderId: "",
                    status: "rejected",
                    filledQuantity: 0,
                    timestamp: Date.now(),
                    error: validation.reason,
                },
                validation,
            }
        }

        await this.tradeEventLogger?.logValidation(this.runId, this.strategyId, ALLOWED_VALIDATION, intent)

        if (this.policy.dryRun) {
            const result: ExecutionResult = {
                orderId: `dry-run-close-${Date.now()}`,
                status: "filled",
                filledQuantity: position.quantity,
                fillPrice: position.currentPrice ?? position.entryPrice,
                timestamp: Date.now(),
            }
            await this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, result, intent)
            const handle = await this.lifecycleManager.registerSubmittedOrder(intent, result, "close", { reason })
            return { result, validation: ALLOWED_VALIDATION, handle }
        }

        const result = await this.venue.closePosition(instrument)
        await this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, result, intent)
        const handle = await this.lifecycleManager.registerSubmittedOrder(intent, result, "close", { reason })
        return { result, validation: ALLOWED_VALIDATION, handle }
    }

    async getOrderStatus(orderId: string): Promise<ExecutionResult> {
        const result = await this.venue.getOrderStatus(orderId)
        await this.lifecycleManager.captureVenueUpdate(orderId, result, "status_change")
        return result
    }

    async waitForOrderUpdate(
        orderId: string,
        onUpdate: OrderStatusCallback,
        options: WaitForOrderUpdateOptions = {}
    ): Promise<OrderSnapshot> {
        return this.lifecycleManager.waitForUpdate(orderId, onUpdate, options)
    }

    async getOrderSnapshot(orderId: string): Promise<OrderSnapshot | null> {
        return this.lifecycleManager.getOrderSnapshot(orderId)
    }

    async resumeOpenOrders(onUpdate: OrderStatusCallback): Promise<OrderSnapshot[]> {
        return this.lifecycleManager.resumeActiveOrders(onUpdate)
    }

    getTrackedOrder(orderId: string): OrderSnapshot | null {
        return this.lifecycleManager.getTrackedSnapshot(orderId)
    }

    getTrackedOrders(): OrderSnapshot[] {
        return this.lifecycleManager.getTrackedOrders()
    }

    stopTracking(orderId: string): void {
        this.lifecycleManager.stopTracking(orderId)
    }

    stopAllTracking(): void {
        this.lifecycleManager.stopAll()
    }

    async getPositions(): Promise<Position[]> {
        return this.venue.getPositions()
    }

    async getAccountState(): Promise<AccountState> {
        return this.venue.getAccountState()
    }
}

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
    private trackedOrders = new Map<string, TrackedOrderState>()

    constructor(
        venue: VenueAdapter,
        logger: Logger,
        config: OrderLifecycleConfig = {},
        orderPersistence?: OrderPersistenceAdapter,
        tradeEventLogger?: TradeEventLogger,
        runId: string = "",
        strategyId: string = "",
        venueName: string = "unknown"
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

        for (const snapshot of snapshots) {
            if (!ACTIVE_ORDER_STATUSES.includes(snapshot.status)) {
                continue
            }

            const tracked: TrackedOrderState = {
                handle: {
                    orderId: snapshot.orderId,
                    action: snapshot.action,
                    snapshot,
                },
                timer: null,
                updateResolvers: [],
                listener: onUpdate,
                transitionSequence: 0,
            }

            this.trackedOrders.set(snapshot.orderId, tracked)
            this.schedulePoll(snapshot.orderId)
        }

        return snapshots
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
        await this.persistTransition(tracked, {
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
        await this.persistTransition(tracked, {
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
                const timedOutResult = createTimedOutExecutionResult(tracked.handle.snapshot)
                await this.persistTransition(tracked, {
                    orderId,
                    strategyId: tracked.handle.snapshot.strategyId,
                    runId: tracked.handle.snapshot.runId,
                    sequence: 0,
                    type: "timeout_decision",
                    status: "timed_out",
                    previousStatus: tracked.handle.snapshot.status,
                    timestamp: timedOutResult.timestamp,
                    reason: timedOutResult.error,
                })
                await this.applyExecutionResult(tracked, timedOutResult, "terminal", timedOutResult.error)
                await this.createAlert({
                    strategyId: tracked.handle.snapshot.strategyId,
                    runId: tracked.handle.snapshot.runId,
                    orderId,
                    severity: "warning",
                    message: `Order ${orderId} timed out while waiting for a terminal venue status`,
                    metadata: {
                        instrument: tracked.handle.snapshot.instrument,
                    },
                })
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
            await this.persistSnapshot(snapshot)
            this.logger.error("Error polling order status", { orderId, error: message })
            await this.createAlert({
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
        tracked.handle = {
            ...tracked.handle,
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
            details: result.error
                ? {
                    error: result.error,
                }
                : undefined,
        }

        await this.persistTransition(tracked, transition)
        await this.tradeEventLogger?.logFillUpdate(this.runId, this.strategyId, result)

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

    private async persistSnapshot(snapshot: OrderSnapshot): Promise<void> {
        await this.orderPersistence?.upsertOrder(snapshot)
    }

    private async persistTransition(tracked: TrackedOrderState, transition: OrderTransition): Promise<void> {
        tracked.transitionSequence += 1
        await this.orderPersistence?.logOrderTransition({
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

    private async createAlert(alert: OrderLifecycleAlert): Promise<void> {
        await this.orderPersistence?.createAlert?.(alert)
    }
}

import type {
    AccountState,
    ExecutionResult,
    OrderIntent,
    OrderLifecycleContext,
    Position,
    ValidationResult,
} from "./types"
import {
    type OrderPersistenceAdapter,
    type OrderSnapshot,
    type TrackedOrderHandle,
    type WaitForOrderUpdateOptions,
    type OrderUpdateDecision,
    type OrderUpdateContext,
} from "./orders"
import { BASE_RISK_VALIDATORS, type RiskValidator, validateIntent } from "./risk"
import { filterPositionsByOwnership } from "./position-filter"
import type { Logger } from "./logger"
import { getIntentAction, hasIntentChanges, createSyntheticIntent } from "./intent"
import { OrderLifecycleManager } from "./order-tracker"

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
    ownedInstruments?: Set<string>
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
    private ownedInstruments: Set<string> | null
    private dryRun: boolean
    private dryRunPositionBook: Map<string, Position>

    constructor(config: ExecutionPipelineConfig) {
        this.venue = config.venue
        this.venueName = config.venueName
        this.policy = config.policy
        this.riskValidators = config.riskValidators ?? BASE_RISK_VALIDATORS
        this.logger = config.logger
        this.tradeEventLogger = config.tradeEventLogger
        this.runId = config.runId
        this.strategyId = config.strategyId
        this.ownedInstruments = config.ownedInstruments ?? null
        this.dryRun = Boolean(config.policy.dryRun)
        this.dryRunPositionBook = new Map()
        this.lifecycleManager = new OrderLifecycleManager(
            config.venue,
            config.logger,
            config.lifecycle,
            config.orderPersistence,
            config.tradeEventLogger,
            config.runId,
            config.strategyId,
            config.venueName,
            (previousSnapshot, currentSnapshot) => {
                this.reconcileOwnedInstrumentsFromSnapshot(previousSnapshot, currentSnapshot)
            }
        )
    }

    async executeIntent(
        intent: OrderIntent,
        accountState: AccountState,
        positions: Position[],
        lifecycleContext: OrderLifecycleContext = { action: getIntentAction(intent) }
    ): Promise<ExecuteIntentResult> {
        this.logger.info("Order intent received", { intent, action: lifecycleContext.action })
        void this.tradeEventLogger?.logIntent(this.runId, this.strategyId, intent)

        const validation = validateIntent(
            intent,
            this.policy,
            accountState,
            positions,
            this.riskValidators
        )
        void this.tradeEventLogger?.logValidation(this.runId, this.strategyId, validation, intent)

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
                fillPrice: finalIntent.limitPrice ?? (finalIntent.metadata?.estimatedPrice as number) ?? 0,
                timestamp: Date.now(),
            }
            void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, mockResult, finalIntent)
            const handle = await this.lifecycleManager.registerSubmittedOrder(
                finalIntent,
                mockResult,
                lifecycleContext.action,
                lifecycleContext.metadata
            )
            this.updateOwnedInstruments(lifecycleContext.action, finalIntent.instrument, mockResult)
            this.netDryRunPosition(
                finalIntent.instrument,
                finalIntent.side,
                finalIntent.quantity,
                mockResult.fillPrice ?? 0,
                lifecycleContext.action
            )
            return { result: mockResult, validation, handle }
        }

        try {
            const result = await this.venue.submitOrder(finalIntent)
            this.logger.info("Order submitted", { orderId: result.orderId, status: result.status })
            void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, result, finalIntent)
            const handle = await this.lifecycleManager.registerSubmittedOrder(
                finalIntent,
                result,
                lifecycleContext.action,
                lifecycleContext.metadata
            )
            this.updateOwnedInstruments(lifecycleContext.action, finalIntent.instrument, result)
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
            void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, failedResult, finalIntent)
            return { result: failedResult, validation }
        }
    }

    async cancelOrder(orderId: string, reason?: string): Promise<ExecutionResult> {
        const existing = await this.lifecycleManager.getOrderSnapshot(orderId)
        const instrument = existing?.instrument ?? "order-cancel"
        const intent = createSyntheticIntent("cancel", instrument, "sell", 0, orderId, { reason })

        this.logger.info("Cancelling order", { orderId, reason })
        void this.tradeEventLogger?.logIntent(this.runId, this.strategyId, intent)
        void this.tradeEventLogger?.logValidation(this.runId, this.strategyId, ALLOWED_VALIDATION, intent)

        if (this.policy.dryRun) {
            const result: ExecutionResult = {
                orderId,
                status: "cancelled",
                filledQuantity: existing?.filledQuantity ?? 0,
                fillPrice: existing?.avgFillPrice,
                timestamp: Date.now(),
            }
            void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, result, intent)
            await this.lifecycleManager.recordCancelAttempt(orderId, reason)
            await this.lifecycleManager.captureVenueUpdate(orderId, result, "cancel_attempt", reason)
            return result
        }

        await this.lifecycleManager.recordCancelAttempt(orderId, reason)
        const result = await this.venue.cancelOrder(orderId)
        void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, result, intent)
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
        void this.tradeEventLogger?.logIntent(this.runId, this.strategyId, intent)

        if (!hasChanges) {
            const validation: ValidationResult = {
                allowed: false,
                reason: "At least one order modification must be provided",
            }
            void this.tradeEventLogger?.logValidation(this.runId, this.strategyId, validation, intent)

            return {
                orderId,
                status: "rejected",
                filledQuantity: existing?.filledQuantity ?? 0,
                fillPrice: existing?.avgFillPrice,
                timestamp: Date.now(),
                error: validation.reason,
            }
        }

        void this.tradeEventLogger?.logValidation(this.runId, this.strategyId, ALLOWED_VALIDATION, intent)
        await this.lifecycleManager.recordModifyAttempt(orderId, changes, reason)

        if (this.policy.dryRun) {
            const result: ExecutionResult = {
                orderId,
                status: existing?.status ?? "pending",
                filledQuantity: existing?.filledQuantity ?? 0,
                fillPrice: existing?.avgFillPrice,
                timestamp: Date.now(),
            }
            void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, result, intent)
            await this.lifecycleManager.captureVenueUpdate(orderId, result, "modify_attempt", reason)
            return result
        }

        const result = await this.venue.modifyOrder(orderId, changes)
        void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, result, intent)
        await this.lifecycleManager.captureVenueUpdate(orderId, result, "modify_attempt", reason)
        return result
    }

    async closePosition(instrument: string, reason?: string): Promise<ExecuteIntentResult> {
        const positions = await this.getPositions()
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
        void this.tradeEventLogger?.logIntent(this.runId, this.strategyId, intent)

        if (!position) {
            const validation: ValidationResult = {
                allowed: false,
                reason: `No open position found for ${instrument}`,
            }
            void this.tradeEventLogger?.logValidation(this.runId, this.strategyId, validation, intent)

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

        void this.tradeEventLogger?.logValidation(this.runId, this.strategyId, ALLOWED_VALIDATION, intent)

        if (this.policy.dryRun) {
            const result: ExecutionResult = {
                orderId: `dry-run-close-${Date.now()}`,
                status: "filled",
                filledQuantity: position.quantity,
                fillPrice: position.currentPrice ?? position.entryPrice,
                timestamp: Date.now(),
            }
            void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, result, intent)
            const handle = await this.lifecycleManager.registerSubmittedOrder(intent, result, "close", { reason })
            this.updateOwnedInstruments("close", instrument, result)
            this.dryRunPositionBook.delete(instrument)
            return { result, validation: ALLOWED_VALIDATION, handle }
        }

        const result = await this.venue.closePosition(instrument)
        void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, result, intent)
        const handle = await this.lifecycleManager.registerSubmittedOrder(intent, result, "close", { reason })
        this.updateOwnedInstruments("close", instrument, result)
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
        if (this.dryRun) {
            return Array.from(this.dryRunPositionBook.values())
        }
        const positions = await this.venue.getPositions()
        if (this.ownedInstruments) {
            return filterPositionsByOwnership(positions, this.ownedInstruments)
        }
        return positions
    }

    seedDryRunPositions(positions: Position[]): void {
        this.dryRunPositionBook.clear()
        for (const position of positions) {
            this.dryRunPositionBook.set(position.instrument, position)
        }
    }

    getDryRunPositions(): Position[] {
        return Array.from(this.dryRunPositionBook.values())
    }

    async getAccountState(): Promise<AccountState> {
        return this.venue.getAccountState()
    }

    private netDryRunPosition(
        instrument: string,
        side: "buy" | "sell",
        quantity: number,
        fillPrice: number,
        action: string
    ): void {
        if (action === "close") {
            this.dryRunPositionBook.delete(instrument)
            return
        }
        if (action !== "entry" && action !== "adjustment") {
            return
        }
        const positionSide = side === "buy" ? "long" : "short"
        const existing = this.dryRunPositionBook.get(instrument)
        if (!existing) {
            this.dryRunPositionBook.set(instrument, {
                instrument,
                side: positionSide,
                quantity,
                entryPrice: fillPrice,
            })
            return
        }
        if (existing.side === positionSide) {
            const totalQty = existing.quantity + quantity
            const avgEntry = (existing.quantity * existing.entryPrice + quantity * fillPrice) / totalQty
            this.dryRunPositionBook.set(instrument, {
                ...existing,
                quantity: totalQty,
                entryPrice: avgEntry,
            })
        } else {
            const netQty = existing.quantity - quantity
            if (netQty <= 0) {
                this.dryRunPositionBook.delete(instrument)
            } else {
                this.dryRunPositionBook.set(instrument, {
                    ...existing,
                    quantity: netQty,
                })
            }
        }
    }

    private updateOwnedInstruments(action: string, instrument: string, result: ExecutionResult): void {
        if (!this.ownedInstruments) {
            return
        }

        if (action === "entry" || action === "adjustment") {
            if (
                result.status === "pending" ||
                result.status === "partially_filled" ||
                result.status === "filled"
            ) {
                this.ownedInstruments.add(instrument)
            }
        }
    }

    private reconcileOwnedInstrumentsFromSnapshot(
        previousSnapshot: OrderSnapshot,
        currentSnapshot: OrderSnapshot
    ): void {
        if (!this.ownedInstruments) {
            return
        }

        if (currentSnapshot.action === "entry" || currentSnapshot.action === "adjustment") {
            const isActive =
                currentSnapshot.status === "pending" ||
                currentSnapshot.status === "partially_filled" ||
                currentSnapshot.status === "filled"

            if (isActive) {
                this.ownedInstruments.add(currentSnapshot.instrument)
                return
            }

            const wasActive =
                previousSnapshot.status === "pending" ||
                previousSnapshot.status === "partially_filled" ||
                previousSnapshot.status === "filled"

            if (wasActive) {
                this.ownedInstruments.delete(currentSnapshot.instrument)
            }
        }

    }
}

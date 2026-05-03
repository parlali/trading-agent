import type {
    AccountState,
    ExecutionResult,
    OrderIntent,
    OrderLifecycleContext,
    Position,
    ProviderPositionClosure,
    ValidationResult,
    WorkingOrder,
} from "./types"
import {
    buildDryRunAccountState,
    createDryRunAccountLedgerPosition,
    DRY_RUN_ACCOUNT_LEDGER_INSTRUMENT,
    isDryRunAccountLedgerPosition,
    resolveDryRunAccountState,
    resolveDryRunCashDelta,
    resolveDryRunCurrentPrice,
    resolveDryRunOpeningCashDelta,
    resolveDryRunRealizedPnl,
    resolveDryRunUnrealizedPnl,
} from "./dry-run-ledger"
import {
    type OrderPersistenceAdapter,
    type OrderSnapshot,
    type TrackedOrderHandle,
    type WaitForOrderUpdateOptions,
    type OrderUpdateDecision,
    type OrderUpdateContext,
} from "./orders"
import {
    BASE_RISK_VALIDATORS,
    isRiskReducingIntent,
    type RiskValidator,
    validateIntent,
} from "./risk"
import {
    filterPositionsByOwnership,
    filterPositionsByOwnershipScope,
    type ProviderOwnershipScope,
} from "./position-filter"
import { resolveStrategyAccountState } from "./strategy-account"
import type { Logger } from "./logger"
import { getIntentAction, hasIntentChanges, createSyntheticIntent } from "./intent"
import { OrderLifecycleManager } from "./order-tracker"
import {
    finalizePriceVerification,
    resolveIntentProposedPrice,
    resolvePriceVerificationConfig,
    type PriceVerification,
    type PriceVerificationConfig,
    type PriceVerifier,
    type ResolvedPriceVerificationConfig,
} from "./price-verification"
import {
    orderSideForPositionSide,
    readNumber,
    readPositionSide,
    withLifecycleAction,
} from "./execution-metadata"
import {
    createRejectedExecutionResultFromUnknownError,
    mergeExecutionIntentUpdates,
    normalizeModifyExecutionResult,
    shouldPersistModifyIntentUpdates,
} from "./execution-result-helpers"
import {
    createExecutionErrorDetail,
    formatExecutionError,
    getErrorMessage,
    getExecutionErrorDetail,
} from "./utils"

export * from "./dry-run-ledger"
export * from "./price-verification"

export interface DryRunOrderSimulator {
    simulateDryRunOrder(intent: OrderIntent): Promise<ExecutionResult>
}

export interface VenueAdapter {
    getPositions(): Promise<Position[]>
    getAccountState(): Promise<AccountState>
    getWorkingOrders?(): Promise<WorkingOrder[]>
    getRecentPositionClosures?(): Promise<ProviderPositionClosure[]>
    submitOrder(intent: OrderIntent): Promise<ExecutionResult>
    cancelOrder(orderId: string): Promise<ExecutionResult>
    modifyOrder(orderId: string, changes: Partial<OrderIntent>): Promise<ExecutionResult>
    closePosition(instrument: string, preparedIntent?: OrderIntent): Promise<ExecutionResult>
    closeProviderPosition?(position: Position, preparedIntent?: OrderIntent): Promise<ExecutionResult>
    getOrderStatus(orderId: string): Promise<ExecutionResult>
    buildCloseIntent?(instrument: string): Promise<OrderIntent>
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
    priceVerification?: PriceVerificationConfig
    logger: Logger
    tradeEventLogger?: TradeEventLogger
    orderPersistence?: OrderPersistenceAdapter
    runId: string
    strategyId: string
    lifecycle?: OrderLifecycleConfig
    ownedInstruments?: Set<string>
    ownershipScope?: ProviderOwnershipScope
    strategyRealizedPnl?: number
}

export interface ExecuteIntentResult {
    result: ExecutionResult
    validation: ValidationResult
    handle?: TrackedOrderHandle
}

export interface ClosePositionOptions {
    estimatedPrice?: number
    metadata?: Record<string, unknown>
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
    private priceVerificationConfig: ResolvedPriceVerificationConfig
    private logger: Logger
    private tradeEventLogger?: TradeEventLogger
    private lifecycleManager: OrderLifecycleManager
    private runId: string
    private strategyId: string
    private ownedInstruments: Set<string> | null
    private ownershipScope: ProviderOwnershipScope | null
    private dryRun: boolean
    private strategyRealizedPnl: number
    private dryRunPositionBook: Map<string, Position>
    private dryRunCashAdjustment: number
    private dryRunRealizedPnl: number

    constructor(config: ExecutionPipelineConfig) {
        this.venue = config.venue
        this.venueName = config.venueName
        this.policy = config.policy
        this.riskValidators = config.riskValidators ?? BASE_RISK_VALIDATORS
        this.priceVerificationConfig = resolvePriceVerificationConfig(config.priceVerification)
        this.logger = config.logger
        this.tradeEventLogger = config.tradeEventLogger
        this.runId = config.runId
        this.strategyId = config.strategyId
        this.ownedInstruments = config.ownedInstruments ?? null
        this.ownershipScope = config.ownershipScope ?? null
        this.dryRun = Boolean(config.policy.dryRun)
        this.strategyRealizedPnl = config.strategyRealizedPnl ?? 0
        this.dryRunPositionBook = new Map()
        this.dryRunCashAdjustment = 0
        this.dryRunRealizedPnl = 0
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
        const intentWithLifecycleMetadata = withLifecycleAction(intent, lifecycleContext)

        this.logger.info("Order intent received", { intent: intentWithLifecycleMetadata, action: lifecycleContext.action })
        void this.tradeEventLogger?.logIntent(this.runId, this.strategyId, intentWithLifecycleMetadata)

        const validation = validateIntent(
            intentWithLifecycleMetadata,
            this.policy,
            accountState,
            positions,
            this.riskValidators
        )
        void this.tradeEventLogger?.logValidation(this.runId, this.strategyId, validation, intentWithLifecycleMetadata)

        if (!validation.allowed) {
            this.logger.warn("Order rejected by risk engine", { reason: validation.reason, intent: intentWithLifecycleMetadata })
            const errorDetail = createExecutionErrorDetail("risk_engine", validation.reason ?? "Order rejected by risk engine")
            const rejectedResult: ExecutionResult = {
                orderId: "",
                status: "rejected",
                filledQuantity: 0,
                timestamp: Date.now(),
                error: formatExecutionError(errorDetail),
                errorDetail,
            }
            return { result: rejectedResult, validation }
        }

        const finalIntent = validation.adjustedIntent ?? intentWithLifecycleMetadata
        const priceVerification = await this.runPriceVerification(finalIntent)

        if (priceVerification?.status === "block") {
            this.logger.warn("Order blocked by price verification", {
                venue: this.venueName,
                intent: finalIntent,
                priceVerification,
            })
            const errorDetail = createExecutionErrorDetail(
                "pre_validation",
                priceVerification.message,
                {
                    code: "PRICE_VERIFICATION_BLOCKED",
                    retryable: false,
                    details: {
                        priceVerification,
                    },
                }
            )
            const rejectedResult: ExecutionResult = {
                orderId: "",
                status: "rejected",
                filledQuantity: 0,
                timestamp: Date.now(),
                error: formatExecutionError(errorDetail),
                errorDetail,
                priceVerification,
            }
            void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, rejectedResult, finalIntent)
            return { result: rejectedResult, validation }
        }

        if (this.policy.dryRun) {
            this.logger.info("Dry run -- order simulated", { intent: finalIntent })
            const mockResult = {
                ...(await this.simulateDryRunOrder(finalIntent)),
                priceVerification,
            }
            void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, mockResult, finalIntent)
            if (mockResult.status === "rejected") {
                return { result: mockResult, validation }
            }

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
                lifecycleContext.action,
                finalIntent.metadata,
                mockResult
            )
            return { result: mockResult, validation, handle }
        }

        try {
            const result = await this.venue.submitOrder(finalIntent)
            const resultWithVerification: ExecutionResult = {
                ...result,
                priceVerification,
            }
            this.logger.info("Order submitted", {
                orderId: resultWithVerification.orderId,
                status: resultWithVerification.status,
                priceVerification,
            })
            void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, resultWithVerification, finalIntent)
            const handle = await this.lifecycleManager.registerSubmittedOrder(
                finalIntent,
                resultWithVerification,
                lifecycleContext.action,
                lifecycleContext.metadata
            )
            this.updateOwnedInstruments(lifecycleContext.action, finalIntent.instrument, resultWithVerification)
            return { result: resultWithVerification, validation, handle }
        } catch (error) {
            const errorDetail = getExecutionErrorDetail(error) ?? createExecutionErrorDetail("internal", getErrorMessage(error))
            const errorMsg = formatExecutionError(errorDetail)
            this.logger.error("Order submission failed", { error: errorMsg, intent: finalIntent })
            const failedResult: ExecutionResult = {
                orderId: "",
                status: "rejected",
                filledQuantity: 0,
                timestamp: Date.now(),
                error: errorMsg,
                errorDetail,
                priceVerification,
            }
            void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, failedResult, finalIntent)
            return { result: failedResult, validation }
        }
    }

    async cancelOrder(orderId: string, reason?: string): Promise<ExecutionResult> {
        const existing = await this.lifecycleManager.getOrderSnapshot(orderId)
        const instrument = existing?.instrument ?? "order-cancel"
        const intent = createSyntheticIntent("cancel", instrument, "sell", 0, orderId, { reason })
        const canonicalOrderId = existing?.orderId ?? orderId
        const providerOrderId = existing?.providerOrderId ?? orderId

        this.logger.info("Cancelling order", { orderId, reason })
        void this.tradeEventLogger?.logIntent(this.runId, this.strategyId, intent)
        void this.tradeEventLogger?.logValidation(this.runId, this.strategyId, ALLOWED_VALIDATION, intent)

        if (this.policy.dryRun) {
            const result: ExecutionResult = {
                orderId: providerOrderId,
                status: "cancelled",
                filledQuantity: existing?.filledQuantity ?? 0,
                fillPrice: existing?.avgFillPrice,
                timestamp: Date.now(),
            }
            void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, result, intent)
            await this.lifecycleManager.recordCancelAttempt(canonicalOrderId, reason)
            await this.lifecycleManager.captureVenueUpdate(canonicalOrderId, result, "cancel_attempt", reason)
            return result
        }

        await this.lifecycleManager.recordCancelAttempt(canonicalOrderId, reason)
        let result: ExecutionResult
        try {
            result = await this.venue.cancelOrder(providerOrderId)
        } catch (error) {
            result = createRejectedExecutionResultFromUnknownError(providerOrderId, error)
        }
        void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, result, intent)
        await this.lifecycleManager.captureVenueUpdate(canonicalOrderId, result, "cancel_attempt", reason)
        return result
    }

    async modifyOrder(orderId: string, changes: Partial<OrderIntent>, reason?: string): Promise<ExecutionResult> {
        const hasChanges = hasIntentChanges(changes)
        const existing = await this.lifecycleManager.getOrderSnapshot(orderId)
        const canonicalOrderId = existing?.orderId ?? orderId
        const providerOrderId = existing?.providerOrderId ?? orderId
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
            const errorDetail = createExecutionErrorDetail("pre_validation", validation.reason ?? "At least one order modification must be provided")

            return {
                orderId,
                status: "rejected",
                filledQuantity: existing?.filledQuantity ?? 0,
                fillPrice: existing?.avgFillPrice,
                timestamp: Date.now(),
                error: formatExecutionError(errorDetail),
                errorDetail,
            }
        }

        void this.tradeEventLogger?.logValidation(this.runId, this.strategyId, ALLOWED_VALIDATION, intent)
        await this.lifecycleManager.recordModifyAttempt(canonicalOrderId, changes, reason)

        if (this.policy.dryRun) {
            const result: ExecutionResult = {
                orderId: providerOrderId,
                status: existing?.status ?? "pending",
                filledQuantity: existing?.filledQuantity ?? 0,
                fillPrice: existing?.avgFillPrice,
                timestamp: Date.now(),
                intentUpdates: changes,
            }
            void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, result, intent)
            await this.lifecycleManager.captureVenueUpdate(canonicalOrderId, result, "modify_attempt", reason)
            return result
        }

        let result: ExecutionResult
        try {
            result = await this.venue.modifyOrder(providerOrderId, changes)
        } catch (error) {
            result = createRejectedExecutionResultFromUnknownError(
                providerOrderId,
                error,
                existing?.filledQuantity ?? 0,
                existing?.avgFillPrice
            )
        }
        const normalizedResult = normalizeModifyExecutionResult(result, existing, providerOrderId)
        const resultWithIntentUpdates: ExecutionResult = {
            ...normalizedResult,
            intentUpdates: shouldPersistModifyIntentUpdates(result)
                ? mergeExecutionIntentUpdates(changes, result.intentUpdates)
                : undefined,
        }
        void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, resultWithIntentUpdates, intent)
        await this.lifecycleManager.captureVenueUpdate(canonicalOrderId, resultWithIntentUpdates, "modify_attempt", reason)
        return resultWithIntentUpdates
    }

    async closePosition(
        instrument: string,
        reason?: string,
        options: ClosePositionOptions = {}
    ): Promise<ExecuteIntentResult> {
        const positions = await this.getPositions()
        const position = positions.find((item) => item.instrument === instrument)
        const closeSide = position?.side === "long" ? "sell" : "buy"
        let venueIntent: OrderIntent | undefined
        if (!this.policy.dryRun && this.venue.buildCloseIntent) {
            try {
                venueIntent = await this.venue.buildCloseIntent(instrument)
            } catch (error) {
                const errorDetail = getExecutionErrorDetail(error) ?? createExecutionErrorDetail("internal", getErrorMessage(error))
                return {
                    result: {
                        orderId: "",
                        status: "rejected",
                        filledQuantity: 0,
                        timestamp: Date.now(),
                        error: formatExecutionError(errorDetail),
                        errorDetail,
                    },
                    validation: {
                        allowed: false,
                        reason: errorDetail.message,
                    },
                }
            }
        }

        const venueMetadata = venueIntent?.metadata
        const venueEntryPrice = readNumber(venueMetadata?.entryPrice)
        const venuePositionSide = readPositionSide(venueMetadata?.positionSide)
        const venueEstimatedPrice = readNumber(venueMetadata?.estimatedPrice)
        const intent: OrderIntent = venueIntent
            ? {
                ...venueIntent,
                metadata: {
                    ...position?.metadata,
                    ...options.metadata,
                    ...venueMetadata,
                    action: "close",
                    reason,
                    entryPrice: position?.entryPrice ?? venueEntryPrice,
                    positionSide: position?.side ?? venuePositionSide,
                    estimatedPrice: options.estimatedPrice ?? venueEstimatedPrice,
                },
            }
            : {
                instrument,
                side: closeSide,
                quantity: position?.quantity ?? 0,
                orderType: "market",
                timeInForce: "day",
                metadata: {
                    ...position?.metadata,
                    ...options.metadata,
                    action: "close",
                    reason,
                    entryPrice: position?.entryPrice,
                    positionSide: position?.side,
                    estimatedPrice: options.estimatedPrice,
                },
            }

        this.logger.info("Closing position", { instrument, reason })
        void this.tradeEventLogger?.logIntent(this.runId, this.strategyId, intent)

        if (!position && !venueIntent) {
            const validation: ValidationResult = {
                allowed: false,
                reason: `No open position found for ${instrument}`,
            }
            void this.tradeEventLogger?.logValidation(this.runId, this.strategyId, validation, intent)
            const errorDetail = createExecutionErrorDetail("pre_validation", validation.reason ?? "No open position found")

            return {
                result: {
                    orderId: "",
                    status: "rejected",
                    filledQuantity: 0,
                    timestamp: Date.now(),
                    error: formatExecutionError(errorDetail),
                    errorDetail,
                },
                validation,
            }
        }

        void this.tradeEventLogger?.logValidation(this.runId, this.strategyId, ALLOWED_VALIDATION, intent)

        if (this.policy.dryRun) {
            if (!position) {
                const validation: ValidationResult = {
                    allowed: false,
                    reason: `No open position found for ${instrument}`,
                }
                const errorDetail = createExecutionErrorDetail("pre_validation", validation.reason ?? "No open position found")
                return {
                    result: {
                        orderId: "",
                        status: "rejected",
                        filledQuantity: 0,
                        timestamp: Date.now(),
                        error: formatExecutionError(errorDetail),
                        errorDetail,
                    },
                    validation,
                }
            }

            const result: ExecutionResult = {
                orderId: `dry-run-close-${Date.now()}`,
                status: "filled",
                filledQuantity: position.quantity,
                fillPrice:
                    (intent.metadata?.estimatedPrice as number | undefined) ??
                    position.currentPrice ??
                    position.entryPrice,
                timestamp: Date.now(),
            }
            void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, result, intent)
            const handle = await this.lifecycleManager.registerSubmittedOrder(intent, result, "close", { reason })
            this.updateOwnedInstruments("close", instrument, result)
            this.netDryRunPosition(
                instrument,
                closeSide,
                position.quantity,
                result.fillPrice ?? position.currentPrice ?? position.entryPrice,
                "close",
                intent.metadata,
                result
            )
            return { result, validation: ALLOWED_VALIDATION, handle }
        }

        let result: ExecutionResult
        try {
            result = await this.venue.closePosition(instrument, intent)
        } catch (error) {
            result = createRejectedExecutionResultFromUnknownError("", error)
        }
        void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, result, intent)
        const handle = await this.lifecycleManager.registerSubmittedOrder(intent, result, "close", { reason })
        this.updateOwnedInstruments("close", instrument, result)
        return { result, validation: ALLOWED_VALIDATION, handle }
    }

    async closeProviderPosition(
        position: Position,
        reason?: string,
        options: ClosePositionOptions = {}
    ): Promise<ExecuteIntentResult> {
        const closeSide = position.side === "long" ? "sell" : "buy"
        const intent: OrderIntent = {
            instrument: position.instrument,
            side: closeSide,
            quantity: position.quantity,
            orderType: "market",
            timeInForce: "ioc",
            metadata: {
                ...position.metadata,
                ...options.metadata,
                action: "close",
                reason,
                providerPositionId: position.providerPositionId,
                entryPrice: position.entryPrice,
                positionSide: position.side,
                estimatedPrice: options.estimatedPrice ?? position.currentPrice ?? position.entryPrice,
            },
        }

        this.logger.info("Closing provider position", {
            instrument: position.instrument,
            providerPositionId: position.providerPositionId,
            reason,
        })
        void this.tradeEventLogger?.logIntent(this.runId, this.strategyId, intent)
        void this.tradeEventLogger?.logValidation(this.runId, this.strategyId, ALLOWED_VALIDATION, intent)

        if (this.policy.dryRun) {
            const result: ExecutionResult = {
                orderId: `dry-run-close-${position.instrument}-${Date.now()}`,
                status: "filled",
                filledQuantity: position.quantity,
                fillPrice: options.estimatedPrice ?? position.currentPrice ?? position.entryPrice,
                timestamp: Date.now(),
            }
            void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, result, intent)
            const handle = await this.lifecycleManager.registerSubmittedOrder(intent, result, "close", { reason })
            this.updateOwnedInstruments("close", position.instrument, result)
            this.netDryRunPosition(
                position.instrument,
                closeSide,
                position.quantity,
                result.fillPrice ?? position.currentPrice ?? position.entryPrice,
                "close",
                intent.metadata,
                result
            )
            return { result, validation: ALLOWED_VALIDATION, handle }
        }

        let result: ExecutionResult
        try {
            result = this.venue.closeProviderPosition
                ? await this.venue.closeProviderPosition(position, intent)
                : await this.venue.closePosition(position.instrument, intent)
        } catch (error) {
            result = createRejectedExecutionResultFromUnknownError("", error)
        }
        void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, result, intent)
        const handle = await this.lifecycleManager.registerSubmittedOrder(intent, result, "close", { reason })
        this.updateOwnedInstruments("close", position.instrument, result)
        return { result, validation: ALLOWED_VALIDATION, handle }
    }

    async getOrderStatus(orderId: string): Promise<ExecutionResult> {
        const existing = await this.lifecycleManager.getOrderSnapshot(orderId)
        const canonicalOrderId = existing?.orderId ?? orderId
        const providerOrderId = existing?.providerOrderId ?? orderId
        const result = await this.venue.getOrderStatus(providerOrderId)
        await this.lifecycleManager.captureVenueUpdate(canonicalOrderId, result, "status_change")
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

    setRiskValidators(validators: readonly RiskValidator[]): void {
        this.riskValidators = [...validators]
    }

    setStrategyRealizedPnl(value: number): void {
        this.strategyRealizedPnl = value
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
        if (this.ownershipScope) {
            return filterPositionsByOwnershipScope(positions, this.ownershipScope)
        }
        if (this.ownedInstruments) {
            return filterPositionsByOwnership(positions, this.ownedInstruments)
        }
        return positions
    }

    seedDryRunPositions(positions: Position[]): void {
        this.dryRunPositionBook.clear()
        this.dryRunCashAdjustment = 0
        this.dryRunRealizedPnl = 0
        const ledger = positions.find((position) => isDryRunAccountLedgerPosition(position))
        if (ledger) {
            this.dryRunCashAdjustment = readNumber(ledger.metadata?.cashAdjustment) ?? 0
            this.dryRunRealizedPnl = readNumber(ledger.metadata?.realizedPnl) ?? 0
        }

        for (const position of positions) {
            if (isDryRunAccountLedgerPosition(position)) {
                continue
            }

            this.dryRunPositionBook.set(position.instrument, position)
            if (!ledger) {
                this.dryRunCashAdjustment += resolveDryRunOpeningCashDelta(position)
            }
        }
    }

    getDryRunPositions(): Position[] {
        return Array.from(this.dryRunPositionBook.values())
    }

    getDryRunPositionsForSync(): Position[] {
        return [
            ...this.getDryRunPositions(),
            this.createDryRunAccountLedgerPosition(),
        ]
    }

    async getAccountState(): Promise<AccountState> {
        if (this.dryRun) {
            return this.getDryRunAccountState()
        }

        const [providerAccountState, positions] = await Promise.all([
            this.venue.getAccountState(),
            this.getPositions(),
        ])

        return resolveStrategyAccountState({
            providerAccountState,
            positions,
            policy: this.policy,
            realizedPnl: this.strategyRealizedPnl,
        })
    }

    private async simulateDryRunOrder(intent: OrderIntent): Promise<ExecutionResult> {
        if (hasDryRunOrderSimulator(this.venue)) {
            return await this.venue.simulateDryRunOrder(intent)
        }

        return {
            orderId: `dry-run-${Date.now()}`,
            status: "filled",
            filledQuantity: intent.quantity,
            fillPrice: intent.limitPrice ?? (intent.metadata?.estimatedPrice as number) ?? 0,
            timestamp: Date.now(),
        }
    }

    private getDryRunAccountState(): AccountState {
        return buildDryRunAccountState({
            policy: this.policy,
            positions: this.getDryRunPositions(),
            cashAdjustment: this.dryRunCashAdjustment,
            realizedPnl: this.dryRunRealizedPnl,
        })
    }

    private async runPriceVerification(intent: OrderIntent): Promise<PriceVerification | undefined> {
        if (!hasPriceVerifier(this.venue)) {
            return undefined
        }

        try {
            const verification = finalizePriceVerification(
                await this.venue.verify(intent),
                this.priceVerificationConfig,
                { riskReducing: isRiskReducingIntent(intent) }
            )

            this.logPriceVerification(intent, verification)
            return verification
        } catch (error) {
            const message = getErrorMessage(error)
            if (this.priceVerificationConfig.failClosedOnVerificationError) {
                const verification = finalizePriceVerification({
                    ok: false,
                    status: "block",
                    livePrices: {},
                    proposedPrice: resolveIntentProposedPrice(intent),
                    message: `Price verification failed closed: ${message}`,
                    details: {
                        venue: this.venueName,
                        verificationError: message,
                    },
                }, this.priceVerificationConfig, { riskReducing: isRiskReducingIntent(intent) })

                this.logger.warn("Price verification failed closed", {
                    venue: this.venueName,
                    intent,
                    error: message,
                })

                return verification
            }

            const verification = finalizePriceVerification({
                ok: true,
                status: "warn",
                livePrices: {},
                proposedPrice: resolveIntentProposedPrice(intent),
                message: `Price verification unavailable: ${message}. Submitted without broker snapshot.`,
                details: {
                    venue: this.venueName,
                    verificationError: message,
                },
            }, this.priceVerificationConfig, { riskReducing: isRiskReducingIntent(intent) })

            this.logger.warn("Price verification failed", {
                venue: this.venueName,
                intent,
                error: message,
            })

            return verification
        }
    }

    private logPriceVerification(intent: OrderIntent, verification: PriceVerification): void {
        if (verification.status === "block") {
            this.logger.warn("Price verification blocked submission", {
                venue: this.venueName,
                intent,
                priceVerification: verification,
            })
            return
        }

        if (verification.status === "warn") {
            this.logger.warn("Price verification warning", {
                venue: this.venueName,
                intent,
                priceVerification: verification,
            })
            return
        }

        if (verification.status === "skipped") {
            this.logger.info("Price verification skipped", {
                venue: this.venueName,
                intent,
                priceVerification: verification,
            })
            return
        }

        this.logger.info("Price verification passed", {
            venue: this.venueName,
            intent,
            priceVerification: verification,
        })
    }

    private netDryRunPosition(
        instrument: string,
        side: "buy" | "sell",
        quantity: number,
        fillPrice: number,
        action: string,
        metadata?: Record<string, unknown>,
        result?: ExecutionResult
    ): void {
        if (action !== "entry" && action !== "adjustment" && action !== "close") {
            return
        }
        const positionSide = side === "buy" ? "long" : "short"
        const existing = this.dryRunPositionBook.get(instrument)
        if (!existing) {
            if (action === "close") {
                return
            }
            this.dryRunCashAdjustment += resolveDryRunCashDelta(side, quantity, fillPrice)
            const currentPrice = resolveDryRunCurrentPrice(metadata, result) ?? fillPrice
            this.dryRunPositionBook.set(instrument, {
                instrument,
                side: positionSide,
                quantity,
                entryPrice: fillPrice,
                currentPrice,
                unrealizedPnl: resolveDryRunUnrealizedPnl(positionSide, quantity, fillPrice, currentPrice),
                metadata: this.buildDryRunPositionMetadata(metadata, side, quantity, fillPrice, currentPrice, result),
            })
            return
        }
        this.dryRunCashAdjustment += resolveDryRunCashDelta(side, quantity, fillPrice)
        if (existing.side === positionSide) {
            const totalQty = existing.quantity + quantity
            const avgEntry = (existing.quantity * existing.entryPrice + quantity * fillPrice) / totalQty
            const currentPrice = resolveDryRunCurrentPrice(metadata, result) ?? existing.currentPrice
            this.dryRunPositionBook.set(instrument, {
                ...existing,
                quantity: totalQty,
                entryPrice: avgEntry,
                currentPrice,
                unrealizedPnl: resolveDryRunUnrealizedPnl(existing.side, totalQty, avgEntry, currentPrice),
                metadata: this.buildDryRunPositionMetadata(
                    {
                        ...existing.metadata,
                        ...metadata,
                    },
                    side,
                    totalQty,
                    avgEntry,
                    currentPrice,
                    result
                ),
            })
        } else {
            const closedQty = Math.min(existing.quantity, quantity)
            this.dryRunRealizedPnl += resolveDryRunRealizedPnl(existing, side, closedQty, fillPrice)
            const netQty = existing.quantity - quantity
            if (netQty === 0) {
                this.dryRunPositionBook.delete(instrument)
            } else if (netQty > 0) {
                const currentPrice = resolveDryRunCurrentPrice(metadata, result) ?? existing.currentPrice
                const remainingSide = orderSideForPositionSide(existing.side)
                this.dryRunPositionBook.set(instrument, {
                    ...existing,
                    quantity: netQty,
                    currentPrice,
                    unrealizedPnl: resolveDryRunUnrealizedPnl(existing.side, netQty, existing.entryPrice, currentPrice),
                    metadata: this.buildDryRunPositionMetadata(
                        {
                            ...existing.metadata,
                            ...metadata,
                        },
                        remainingSide,
                        netQty,
                        existing.entryPrice,
                        currentPrice,
                        result
                    ),
                })
            } else if (action !== "close") {
                const flippedQty = Math.abs(netQty)
                const currentPrice = resolveDryRunCurrentPrice(metadata, result) ?? fillPrice
                this.dryRunPositionBook.set(instrument, {
                    instrument,
                    side: positionSide,
                    quantity: flippedQty,
                    entryPrice: fillPrice,
                    currentPrice,
                    unrealizedPnl: resolveDryRunUnrealizedPnl(positionSide, flippedQty, fillPrice, currentPrice),
                    metadata: this.buildDryRunPositionMetadata(metadata, side, flippedQty, fillPrice, currentPrice, result),
                })
            }
        }
    }

    private buildDryRunPositionMetadata(
        metadata: Record<string, unknown> | undefined,
        side: "buy" | "sell",
        quantity: number,
        entryPrice: number,
        currentPrice: number | undefined,
        result?: ExecutionResult
    ): Record<string, unknown> {
        return {
            ...metadata,
            side,
            quantity,
            entryPrice,
            currentPrice,
            sourceOrderId: result?.orderId,
            sourceRunId: this.runId,
        }
    }

    private createDryRunAccountLedgerPosition(): Position {
        return createDryRunAccountLedgerPosition({
            policy: this.policy,
            positions: this.getDryRunPositions(),
            cashAdjustment: this.dryRunCashAdjustment,
            realizedPnl: this.dryRunRealizedPnl,
            runId: this.runId,
        })
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

function hasPriceVerifier(venue: VenueAdapter): venue is VenueAdapter & PriceVerifier {
    return typeof (venue as Partial<PriceVerifier>).verify === "function"
}

function hasDryRunOrderSimulator(venue: VenueAdapter): venue is VenueAdapter & DryRunOrderSimulator {
    return typeof (venue as Partial<DryRunOrderSimulator>).simulateDryRunOrder === "function"
}

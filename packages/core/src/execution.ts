import type {
    AccountState,
    ExecutionResult,
    OrderIntent,
    OrderLifecycleContext,
    Position,
    ValidationResult,
} from "./types"
import {
    type OrderSnapshot,
    type WaitForOrderUpdateOptions,
} from "./orders"
import {
    BASE_RISK_VALIDATORS,
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
    resolvePriceVerificationConfig,
    type ResolvedPriceVerificationConfig,
} from "./price-verification"
import type {
    ClosePositionOptions,
    ExecuteIntentResult,
    ExecutionPipelineConfig,
    OrderStatusCallback,
    TradeEventLogger,
    VenueAdapter,
} from "./execution-contracts"
import {
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
import {
    buildClosePositionIntent,
    buildProviderPositionCloseIntent,
    resolveCloseOrderSide,
} from "./execution-close-intents"
import {
    DryRunExecutionBook,
    simulateDryRunOrder,
} from "./execution-dry-run"
import { runExecutionPriceVerification } from "./execution-price-verification"
import {
    reconcileOwnedInstrumentsFromSnapshots,
    updateOwnedInstrumentsFromResult,
} from "./execution-ownership"

export * from "./dry-run-ledger"
export * from "./price-verification"
export type {
    ClosePositionOptions,
    DryRunOrderSimulator,
    ExecuteIntentResult,
    ExecutionPipelineConfig,
    OrderLifecycleConfig,
    OrderStatusCallback,
    TradeEventLogger,
    VenueAdapter,
} from "./execution-contracts"

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
    private dryRunBook: DryRunExecutionBook

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
        this.dryRunBook = new DryRunExecutionBook(this.policy, this.runId)
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
                reconcileOwnedInstrumentsFromSnapshots(this.ownedInstruments, previousSnapshot, currentSnapshot)
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
        const priceVerification = await runExecutionPriceVerification({
            venue: this.venue,
            venueName: this.venueName,
            config: this.priceVerificationConfig,
            logger: this.logger,
            intent: finalIntent,
        })

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
                ...(await simulateDryRunOrder(this.venue, finalIntent)),
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
            updateOwnedInstrumentsFromResult(this.ownedInstruments, lifecycleContext.action, finalIntent.instrument, mockResult)
            this.dryRunBook.netPosition(
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
            updateOwnedInstrumentsFromResult(this.ownedInstruments, lifecycleContext.action, finalIntent.instrument, resultWithVerification)
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
        const closeSide = resolveCloseOrderSide(position)
        let venueIntent: OrderIntent | undefined
        if (!this.policy.dryRun && this.venue.buildCloseIntent) {
            try {
                venueIntent = await this.venue.buildCloseIntent(instrument)
            } catch (error) {
                const errorDetail = getExecutionErrorDetail(error) ?? createExecutionErrorDetail("internal", getErrorMessage(error))
                return createRejectedExecuteIntentResult(
                    {
                        allowed: false,
                        reason: errorDetail.message,
                    },
                    errorDetail
                )
            }
        }

        const intent = buildClosePositionIntent({
            instrument,
            position,
            venueIntent,
            reason,
            options,
        })

        this.logger.info("Closing position", { instrument, reason })
        void this.tradeEventLogger?.logIntent(this.runId, this.strategyId, intent)

        if (!position && !venueIntent) {
            const validation = createNoOpenPositionValidation(instrument)
            void this.tradeEventLogger?.logValidation(this.runId, this.strategyId, validation, intent)
            return createRejectedExecuteIntentResult(
                validation,
                createExecutionErrorDetail("pre_validation", validation.reason ?? "No open position found")
            )
        }

        void this.tradeEventLogger?.logValidation(this.runId, this.strategyId, ALLOWED_VALIDATION, intent)

        if (this.policy.dryRun) {
            if (!position) {
                const validation = createNoOpenPositionValidation(instrument)
                return createRejectedExecuteIntentResult(
                    validation,
                    createExecutionErrorDetail("pre_validation", validation.reason ?? "No open position found")
                )
            }

            return await this.recordCloseResult({
                instrument,
                closeSide,
                quantity: position.quantity,
                fallbackFillPrice: position.currentPrice ?? position.entryPrice,
                intent,
                reason,
                dryRun: true,
                result: {
                    orderId: `dry-run-close-${Date.now()}`,
                    status: "filled",
                    filledQuantity: position.quantity,
                    fillPrice:
                        (intent.metadata?.estimatedPrice as number | undefined) ??
                        position.currentPrice ??
                        position.entryPrice,
                    timestamp: Date.now(),
                },
            })
        }

        let result: ExecutionResult
        try {
            result = await this.venue.closePosition(instrument, intent)
        } catch (error) {
            result = createRejectedExecutionResultFromUnknownError("", error)
        }
        return await this.recordCloseResult({
            instrument,
            closeSide,
            quantity: position?.quantity ?? 0,
            fallbackFillPrice: position?.currentPrice ?? position?.entryPrice ?? 0,
            intent,
            reason,
            dryRun: false,
            result,
        })
    }

    async closeProviderPosition(
        position: Position,
        reason?: string,
        options: ClosePositionOptions = {}
    ): Promise<ExecuteIntentResult> {
        const closeSide = resolveCloseOrderSide(position)
        const intent = buildProviderPositionCloseIntent({ position, reason, options })

        this.logger.info("Closing provider position", {
            instrument: position.instrument,
            providerPositionId: position.providerPositionId,
            reason,
        })
        void this.tradeEventLogger?.logIntent(this.runId, this.strategyId, intent)
        void this.tradeEventLogger?.logValidation(this.runId, this.strategyId, ALLOWED_VALIDATION, intent)

        if (this.policy.dryRun) {
            return await this.recordCloseResult({
                instrument: position.instrument,
                closeSide,
                quantity: position.quantity,
                fallbackFillPrice: position.currentPrice ?? position.entryPrice,
                intent,
                reason,
                dryRun: true,
                result: {
                    orderId: `dry-run-close-${position.instrument}-${Date.now()}`,
                    status: "filled",
                    filledQuantity: position.quantity,
                    fillPrice: options.estimatedPrice ?? position.currentPrice ?? position.entryPrice,
                    timestamp: Date.now(),
                },
            })
        }

        let result: ExecutionResult
        try {
            result = this.venue.closeProviderPosition
                ? await this.venue.closeProviderPosition(position, intent)
                : await this.venue.closePosition(position.instrument, intent)
        } catch (error) {
            result = createRejectedExecutionResultFromUnknownError("", error)
        }
        return await this.recordCloseResult({
            instrument: position.instrument,
            closeSide,
            quantity: position.quantity,
            fallbackFillPrice: position.currentPrice ?? position.entryPrice,
            intent,
            reason,
            dryRun: false,
            result,
        })
    }

    private async recordCloseResult(args: {
        instrument: string
        closeSide: "buy" | "sell"
        quantity: number
        fallbackFillPrice: number
        intent: OrderIntent
        result: ExecutionResult
        reason?: string
        dryRun: boolean
    }): Promise<ExecuteIntentResult> {
        void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, args.result, args.intent)
        const handle = await this.lifecycleManager.registerSubmittedOrder(args.intent, args.result, "close", { reason: args.reason })
        updateOwnedInstrumentsFromResult(this.ownedInstruments, "close", args.instrument, args.result)

        if (args.dryRun) {
            this.dryRunBook.netPosition(
                args.instrument,
                args.closeSide,
                args.quantity,
                args.result.fillPrice ?? args.fallbackFillPrice,
                "close",
                args.intent.metadata,
                args.result
            )
        }

        return { result: args.result, validation: ALLOWED_VALIDATION, handle }
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
            return this.dryRunBook.getPositions()
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
        this.dryRunBook.seedPositions(positions)
    }

    getDryRunPositions(): Position[] {
        return this.dryRunBook.getPositions()
    }

    getDryRunPositionsForSync(): Position[] {
        return this.dryRunBook.getPositionsForSync()
    }

    async getAccountState(): Promise<AccountState> {
        if (this.dryRun) {
            return this.dryRunBook.getAccountState()
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
}

function createNoOpenPositionValidation(instrument: string): ValidationResult {
    return {
        allowed: false,
        reason: `No open position found for ${instrument}`,
    }
}

function createRejectedExecuteIntentResult(
    validation: ValidationResult,
    errorDetail: ReturnType<typeof createExecutionErrorDetail>
): ExecuteIntentResult {
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

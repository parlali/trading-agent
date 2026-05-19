import type {
    AccountState,
    ExecutionResult,
    OrderIntent,
    OrderLifecycleContext,
    Position,
    ValidationResult,
} from "./types"
import {
    isTerminalOrderStatus,
    type OrderSnapshot,
    type TrackedOrderHandle,
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
    ExecutionSafetyFaultInput,
    ExecutionSafetyFaultRecorder,
    ExecutionPipelineConfig,
    OrderStatusCallback,
    SubmitOrderContext,
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
import { createExecutionIdentity, mergeExecutionIdentity } from "./execution-identity"
import {
    createPreparedSubmitExecutionResult,
    normalizeExecutionResultIdentity,
    submitOrderWithIdentity,
    submitWithIdentity,
} from "./execution-submit-recovery"
import {
    createExecutionErrorDetail,
    createExecutionError,
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
export * from "./execution-identity"
export * from "./execution-submit-recovery"
export type {
    ClosePositionOptions,
    DryRunOrderSimulator,
    ExecuteIntentResult,
    ExecutionPipelineConfig,
    ExecutionSafetyFaultRecorder,
    OrderLifecycleConfig,
    OrderStatusCallback,
    OrderOperationContext,
    SubmitOrderContext,
    SubmitRecoveryResult,
    TradeEventLogger,
    VenueAdapter,
    ExecutionSafetyFaultInput,
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
    private orderIdentitySequences = new Map<string, number>()
    private runtimeCommitUnknownBlockedInstruments = new Set<string>()
    private executionSafetyFaultRecorder?: ExecutionSafetyFaultRecorder
    private reservedSubmitAttemptIds = new Set<string>()
    private submitAttemptSnapshots = new Map<string, OrderSnapshot>()

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
        this.executionSafetyFaultRecorder = config.executionSafetyFaultRecorder
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

        const runtimeBlockValidation = this.validateRuntimeCommitUnknownBlock(
            intentWithLifecycleMetadata,
            lifecycleContext.action
        )
        if (!runtimeBlockValidation.allowed) {
            const errorDetail = createExecutionErrorDetail(
                "risk_engine",
                runtimeBlockValidation.reason ?? "Order blocked by unresolved commit-unknown exposure"
            )
            const rejectedResult: ExecutionResult = {
                orderId: "",
                status: "rejected",
                filledQuantity: 0,
                timestamp: Date.now(),
                error: formatExecutionError(errorDetail),
                errorDetail,
            }
            void this.tradeEventLogger?.logValidation(this.runId, this.strategyId, runtimeBlockValidation, intentWithLifecycleMetadata)
            void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, rejectedResult, intentWithLifecycleMetadata)
            return { result: rejectedResult, validation: runtimeBlockValidation }
        }

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

        const submitContext = await this.createSubmitContext(finalIntent, lifecycleContext.action)

        if (this.policy.dryRun) {
            this.logger.info("Dry run -- order simulated", { intent: finalIntent })
            const mockResult = normalizeExecutionResultIdentity({
                ...(await simulateDryRunOrder(this.venue, finalIntent, submitContext)),
                priceVerification,
            }, submitContext.identity)
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
            this.rememberSubmitAttemptSnapshot(handle?.snapshot)
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

        const preparedHandle = await this.lifecycleManager.registerSubmittedOrder(
            finalIntent,
            createPreparedSubmitExecutionResult(submitContext.identity),
            lifecycleContext.action,
            lifecycleContext.metadata
        )

        const result = await submitOrderWithIdentity({
            venue: this.venue,
            intent: finalIntent,
            context: submitContext,
        })
        const resultWithVerification: ExecutionResult = {
            ...result,
            priceVerification,
        }
        this.logger.info("Order submitted", {
            orderId: resultWithVerification.orderId,
            providerOrderId: resultWithVerification.providerOrderId,
            providerClientOrderId: resultWithVerification.providerClientOrderId,
            status: resultWithVerification.status,
            commitOutcome: resultWithVerification.commitOutcome,
            priceVerification,
        })
        void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, resultWithVerification, finalIntent)
        const updatedSnapshot = await this.lifecycleManager.captureVenueUpdate(
            submitContext.identity.canonicalOrderId,
            resultWithVerification,
            "status_change"
        )
        this.rememberSubmitAttemptSnapshot(updatedSnapshot)
        await this.recordCommitUnknownSafetyFaultIfNeeded(finalIntent, lifecycleContext.action, resultWithVerification)
        if (preparedHandle) {
            preparedHandle.snapshot = updatedSnapshot
        }
        updateOwnedInstrumentsFromResult(this.ownedInstruments, lifecycleContext.action, finalIntent.instrument, resultWithVerification)
        return { result: resultWithVerification, validation, handle: preparedHandle }
    }

    async cancelOrder(orderId: string, reason?: string): Promise<ExecutionResult> {
        const existing = await this.lifecycleManager.getOrderSnapshot(orderId)
        const instrument = existing?.instrument ?? "order-cancel"
        const intent = createSyntheticIntent("cancel", instrument, "sell", 0, orderId, { reason })
        let canonicalOrderId = existing?.orderId ?? orderId
        const providerOrderId = existing?.providerOrderId ?? orderId
        let cancelIdentity: SubmitOrderContext["identity"] = {
            canonicalOrderId,
            providerClientOrderId: existing?.providerClientOrderId ?? canonicalOrderId,
            providerOrderId,
            providerOrderAliases: existing?.providerOrderAliases ?? [],
            submitAttemptId: existing?.submitAttemptId ?? "",
            submitAttemptSequence: existing?.submitAttemptSequence ?? 1,
            commitOutcome: "accepted",
            venue: this.venueName,
            role: "cancel",
            sequence: 0,
        }
        let preparedHandle: TrackedOrderHandle | undefined

        this.logger.info("Cancelling order", { orderId, reason })
        void this.tradeEventLogger?.logIntent(this.runId, this.strategyId, intent)
        void this.tradeEventLogger?.logValidation(this.runId, this.strategyId, ALLOWED_VALIDATION, intent)

        if (!existing) {
            const submitContext = await this.createSubmitContext(intent, "cancel")
            cancelIdentity = {
                ...submitContext.identity,
                providerOrderId,
            }
            canonicalOrderId = cancelIdentity.canonicalOrderId
            preparedHandle = await this.lifecycleManager.registerSubmittedOrder(
                intent,
                createPreparedSubmitExecutionResult(cancelIdentity),
                "cancel",
                {
                    reason,
                    providerOrderId,
                    originalOrderId: orderId,
                }
            )
        }

        if (this.policy.dryRun) {
            const result: ExecutionResult = {
                orderId: canonicalOrderId,
                canonicalOrderId,
                providerOrderId,
                providerClientOrderId: cancelIdentity.providerClientOrderId,
                providerOrderAliases: cancelIdentity.providerOrderAliases,
                submitAttemptId: cancelIdentity.submitAttemptId,
                submitAttemptSequence: cancelIdentity.submitAttemptSequence,
                commitOutcome: "accepted",
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
            result = await this.venue.cancelOrder(providerOrderId, {
                canonicalOrderId,
                providerOrderId,
                providerClientOrderId: existing?.providerClientOrderId,
                providerOrderAliases: cancelIdentity.providerOrderAliases,
                signedOrderFingerprint: existing?.signedOrderFingerprint,
            })
        } catch (error) {
            result = createRejectedExecutionResultFromUnknownError(providerOrderId, error)
        }
        result = normalizeExecutionResultIdentity(result, {
            ...cancelIdentity,
            commitOutcome: result.status === "rejected" ? "rejected" : "accepted",
        })
        void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, result, intent)
        const updatedSnapshot = await this.lifecycleManager.captureVenueUpdate(canonicalOrderId, result, "cancel_attempt", reason)
        if (preparedHandle) {
            preparedHandle.snapshot = updatedSnapshot
        }
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
                orderId: canonicalOrderId,
                canonicalOrderId,
                providerOrderId,
                providerClientOrderId: existing?.providerClientOrderId,
                providerOrderAliases: existing?.providerOrderAliases,
                commitOutcome: "accepted",
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
            result = await this.venue.modifyOrder(providerOrderId, changes, {
                canonicalOrderId,
                providerOrderId,
                providerClientOrderId: existing?.providerClientOrderId,
                providerOrderAliases: existing?.providerOrderAliases,
                signedOrderFingerprint: existing?.signedOrderFingerprint,
            })
        } catch (error) {
            result = createRejectedExecutionResultFromUnknownError(
                providerOrderId,
                error,
                existing?.filledQuantity ?? 0,
                existing?.avgFillPrice
            )
        }
        const identityNormalizedResult = normalizeExecutionResultIdentity(result, {
            canonicalOrderId,
            providerClientOrderId: existing?.providerClientOrderId ?? canonicalOrderId,
            providerOrderId,
            providerOrderAliases: existing?.providerOrderAliases ?? [],
            submitAttemptId: existing?.submitAttemptId ?? "",
            submitAttemptSequence: existing?.submitAttemptSequence ?? 1,
            commitOutcome: result.status === "rejected" ? "rejected" : "accepted",
            venue: this.venueName,
            role: "modify",
            sequence: 0,
        })
        const normalizedResult = normalizeModifyExecutionResult(identityNormalizedResult, existing, providerOrderId)
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
        const submitContext = await this.createSubmitContext(intent, "close")

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
                    orderId: submitContext.identity.canonicalOrderId,
                    canonicalOrderId: submitContext.identity.canonicalOrderId,
                    providerClientOrderId: submitContext.identity.providerClientOrderId,
                    submitAttemptId: submitContext.identity.submitAttemptId,
                    submitAttemptSequence: submitContext.identity.submitAttemptSequence,
                    commitOutcome: "accepted",
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

        const preparedHandle = await this.lifecycleManager.registerSubmittedOrder(
            intent,
            createPreparedSubmitExecutionResult(submitContext.identity),
            "close",
            { reason }
        )

        let result: ExecutionResult
        try {
            result = await submitWithIdentity({
                venue: this.venue,
                intent,
                context: submitContext,
                submit: async () => await this.venue.closePosition(instrument, intent, submitContext),
            })
        } catch (error) {
            result = createRejectedExecutionResultFromUnknownError("", error)
            result = normalizeExecutionResultIdentity(result, submitContext.identity)
        }
        await this.recordCommitUnknownSafetyFaultIfNeeded(intent, "close", result)
        return await this.recordCloseResult({
            instrument,
            closeSide,
            quantity: position?.quantity ?? 0,
            fallbackFillPrice: position?.currentPrice ?? position?.entryPrice ?? 0,
            intent,
            reason,
            dryRun: false,
            result,
            preparedHandle,
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
        const submitContext = await this.createSubmitContext(intent, "close")

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
                    orderId: submitContext.identity.canonicalOrderId,
                    canonicalOrderId: submitContext.identity.canonicalOrderId,
                    providerClientOrderId: submitContext.identity.providerClientOrderId,
                    submitAttemptId: submitContext.identity.submitAttemptId,
                    submitAttemptSequence: submitContext.identity.submitAttemptSequence,
                    commitOutcome: "accepted",
                    status: "filled",
                    filledQuantity: position.quantity,
                    fillPrice: options.estimatedPrice ?? position.currentPrice ?? position.entryPrice,
                    timestamp: Date.now(),
                },
            })
        }

        const preparedHandle = await this.lifecycleManager.registerSubmittedOrder(
            intent,
            createPreparedSubmitExecutionResult(submitContext.identity),
            "close",
            { reason }
        )

        let result: ExecutionResult
        try {
            result = await submitWithIdentity({
                venue: this.venue,
                intent,
                context: submitContext,
                submit: async () => this.venue.closeProviderPosition
                    ? await this.venue.closeProviderPosition(position, intent, submitContext)
                    : await this.venue.closePosition(position.instrument, intent, submitContext),
            })
        } catch (error) {
            result = createRejectedExecutionResultFromUnknownError("", error)
            result = normalizeExecutionResultIdentity(result, submitContext.identity)
        }
        await this.recordCommitUnknownSafetyFaultIfNeeded(intent, "close", result)
        return await this.recordCloseResult({
            instrument: position.instrument,
            closeSide,
            quantity: position.quantity,
            fallbackFillPrice: position.currentPrice ?? position.entryPrice,
            intent,
            reason,
            dryRun: false,
            result,
            preparedHandle,
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
        preparedHandle?: TrackedOrderHandle
    }): Promise<ExecuteIntentResult> {
        void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, args.result, args.intent)
        const handle = args.preparedHandle ?? await this.lifecycleManager.registerSubmittedOrder(args.intent, args.result, "close", { reason: args.reason })
        if (args.preparedHandle) {
            const updatedSnapshot = await this.lifecycleManager.captureVenueUpdate(
                args.preparedHandle.orderId,
                args.result,
                "status_change",
                args.reason
            )
            args.preparedHandle.snapshot = updatedSnapshot
        }
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

    private async createSubmitContext(
        intent: OrderIntent,
        action: SubmitOrderContext["identity"]["role"] | "adjustment"
    ): Promise<SubmitOrderContext> {
        const sequence = this.resolveIdentitySequence(intent, action)
        const attemptSequence = this.resolveSubmitAttemptSequence(intent)
        let identity = createExecutionIdentity({
            venue: this.venueName,
            strategyId: this.strategyId,
            runId: this.runId,
            role: action,
            instrument: intent.instrument,
            normalizedIntent: intent,
            sequence,
            attemptSequence,
        })
        const preparedIdentity = this.policy.dryRun
            ? undefined
            : await this.venue.prepareOrderIdentity?.(intent, { identity })
        if (preparedIdentity) {
            identity = mergeExecutionIdentity(identity, preparedIdentity)
        }
        if (!this.reservedSubmitAttemptIds.has(identity.submitAttemptId)) {
            await this.validateSubmitAttemptProgression(identity, intent)
        }
        this.reserveSubmitAttempt(identity.submitAttemptId, identity.canonicalOrderId, intent)

        return { identity }
    }

    private async validateSubmitAttemptProgression(
        identity: SubmitOrderContext["identity"],
        intent: OrderIntent
    ): Promise<void> {
        const existing = await this.lifecycleManager.getOrderSnapshot(identity.canonicalOrderId) ??
            this.submitAttemptSnapshots.get(identity.canonicalOrderId) ??
            null
        if (!existing) {
            if (identity.submitAttemptSequence > 1) {
                throw createExecutionError(
                    "pre_validation",
                    `Submit attempt sequence ${identity.submitAttemptSequence} for ${identity.canonicalOrderId} cannot be accepted because no prior canonical order snapshot proves terminal provider truth.`,
                    {
                        code: "SUBMIT_ATTEMPT_PRIOR_ORDER_NOT_FOUND",
                        retryable: false,
                        details: {
                            canonicalOrderId: identity.canonicalOrderId,
                            submitAttemptId: identity.submitAttemptId,
                            submitAttemptSequence: identity.submitAttemptSequence,
                            instrument: intent.instrument,
                        },
                    }
                )
            }

            return
        }

        const existingSequence = existing.submitAttemptSequence ?? 1
        if (identity.submitAttemptSequence <= existingSequence) {
            throw createExecutionError(
                "pre_validation",
                `Submit attempt sequence ${identity.submitAttemptSequence} for ${identity.canonicalOrderId} is not higher than the persisted attempt sequence ${existingSequence}.`,
                {
                    code: "SUBMIT_ATTEMPT_SEQUENCE_NOT_INCREASING",
                    retryable: false,
                    details: {
                        canonicalOrderId: identity.canonicalOrderId,
                        submitAttemptId: identity.submitAttemptId,
                        submitAttemptSequence: identity.submitAttemptSequence,
                        existingSubmitAttemptId: existing.submitAttemptId,
                        existingSubmitAttemptSequence: existingSequence,
                        existingStatus: existing.status,
                        existingCommitOutcome: existing.commitOutcome,
                        instrument: intent.instrument,
                    },
                }
            )
        }

        if (
            existing.commitOutcome === "commit_unknown" ||
            existing.status === "timed_out" ||
            !isTerminalOrderStatus(existing.status)
        ) {
            throw createExecutionError(
                "pre_validation",
                `Submit attempt sequence ${identity.submitAttemptSequence} for ${identity.canonicalOrderId} is blocked until the previous attempt is proven terminal by provider truth.`,
                {
                    code: "SUBMIT_ATTEMPT_PREVIOUS_NOT_TERMINAL",
                    retryable: false,
                    details: {
                        canonicalOrderId: identity.canonicalOrderId,
                        submitAttemptId: identity.submitAttemptId,
                        submitAttemptSequence: identity.submitAttemptSequence,
                        existingSubmitAttemptId: existing.submitAttemptId,
                        existingSubmitAttemptSequence: existingSequence,
                        existingStatus: existing.status,
                        existingCommitOutcome: existing.commitOutcome,
                        instrument: intent.instrument,
                    },
                }
            )
        }
    }

    private rememberSubmitAttemptSnapshot(snapshot: OrderSnapshot | undefined | null): void {
        if (snapshot) {
            this.submitAttemptSnapshots.set(snapshot.orderId, snapshot)
        }
    }

    private validateRuntimeCommitUnknownBlock(
        intent: OrderIntent,
        action: OrderLifecycleContext["action"]
    ): ValidationResult {
        if (
            (action === "entry" || action === "adjustment") &&
            this.runtimeCommitUnknownBlockedInstruments.has(intent.instrument)
        ) {
            return {
                allowed: false,
                reason: `Instrument ${intent.instrument} has an unresolved commit-unknown live submission in this run. New entries and size-ins are blocked until provider truth resolves it.`,
            }
        }

        return ALLOWED_VALIDATION
    }

    private async recordCommitUnknownSafetyFaultIfNeeded(
        intent: OrderIntent,
        action: OrderLifecycleContext["action"],
        result: ExecutionResult
    ): Promise<void> {
        if (result.commitOutcome !== "commit_unknown") {
            return
        }

        this.runtimeCommitUnknownBlockedInstruments.add(intent.instrument)
        const recoveryProbeEvidence = readRecoveryProbeEvidence(result)
        const fault: ExecutionSafetyFaultInput = {
            strategyId: this.strategyId,
            runId: this.runId,
            venue: this.venueName,
            instrument: intent.instrument,
            canonicalOrderId: result.canonicalOrderId ?? result.orderId,
            providerOrderId: result.providerOrderId,
            providerClientOrderId: result.providerClientOrderId,
            providerOrderAliases: result.providerOrderAliases,
            submitAttemptId: result.submitAttemptId,
            submitAttemptSequence: result.submitAttemptSequence,
            signedOrderFingerprint: result.signedOrderFingerprint,
            commitOutcome: "commit_unknown",
            category: isDuplicateExposureRecoveryEvidence(recoveryProbeEvidence)
                ? "duplicate_exposure"
                : "commit_unknown",
            message: result.errorDetail?.message ?? result.error ?? "Live submission ended with commit-unknown provider state",
            recoveryProbeEvidence,
            providerPayload: JSON.stringify({
                action,
                result,
                recoveryProbeEvidence,
            }),
        }

        try {
            await this.executionSafetyFaultRecorder?.(fault)
        } catch (error) {
            const message = getErrorMessage(error)
            this.logger.error("Failed to persist commit-unknown execution safety fault", {
                instrument: intent.instrument,
                canonicalOrderId: fault.canonicalOrderId,
                submitAttemptId: fault.submitAttemptId,
                error: message,
            })
            throw createExecutionError(
                "internal",
                `Failed to persist commit-unknown execution safety fault for ${fault.canonicalOrderId}: ${message}`,
                {
                    code: "COMMIT_UNKNOWN_FAULT_PERSISTENCE_FAILED",
                    retryable: true,
                    details: {
                        canonicalOrderId: fault.canonicalOrderId,
                        instrument: intent.instrument,
                    },
                }
            )
        }
    }

    private resolveIdentitySequence(
        intent: OrderIntent,
        action: SubmitOrderContext["identity"]["role"] | "adjustment"
    ): number {
        const explicitSequence = intent.metadata?.logicalOrderSequence
        if (typeof explicitSequence === "number" && Number.isInteger(explicitSequence)) {
            return explicitSequence
        }

        const key = `${action}:${intent.instrument}`
        const next = (this.orderIdentitySequences.get(key) ?? 0) + 1
        this.orderIdentitySequences.set(key, next)
        return next
    }

    private resolveSubmitAttemptSequence(intent: OrderIntent): number {
        const explicitSequence = intent.metadata?.submitAttemptSequence
        if (typeof explicitSequence === "number" && Number.isInteger(explicitSequence)) {
            return explicitSequence
        }

        return 1
    }

    private reserveSubmitAttempt(
        submitAttemptId: string,
        canonicalOrderId: string,
        intent: OrderIntent
    ): void {
        if (!this.reservedSubmitAttemptIds.has(submitAttemptId)) {
            this.reservedSubmitAttemptIds.add(submitAttemptId)
            return
        }

        throw createExecutionError(
            "pre_validation",
            `Submit attempt ${submitAttemptId} for ${canonicalOrderId} has already been used in this execution pipeline. Re-submit the same logical order only with an explicit higher submitAttemptSequence after provider truth is terminal.`,
            {
                code: "SUBMIT_ATTEMPT_SEQUENCE_REUSED",
                retryable: false,
                details: {
                    canonicalOrderId,
                    submitAttemptId,
                    instrument: intent.instrument,
                    submitAttemptSequence: intent.metadata?.submitAttemptSequence,
                    logicalOrderSequence: intent.metadata?.logicalOrderSequence,
                },
            }
        )
    }

    async getOrderStatus(orderId: string): Promise<ExecutionResult> {
        const existing = await this.lifecycleManager.getOrderSnapshot(orderId)
        const canonicalOrderId = existing?.orderId ?? orderId
        const providerOrderId = existing?.providerOrderId ?? orderId
        const result = await this.venue.getOrderStatus(providerOrderId)
        const normalizedResult = normalizeExecutionResultIdentity(result, {
            canonicalOrderId,
            providerClientOrderId: existing?.providerClientOrderId ?? canonicalOrderId,
            providerOrderId,
            providerOrderAliases: existing?.providerOrderAliases ?? [],
            submitAttemptId: existing?.submitAttemptId ?? "",
            submitAttemptSequence: existing?.submitAttemptSequence ?? 1,
            commitOutcome: existing?.commitOutcome ?? "accepted",
            venue: this.venueName,
            role: existing?.action === "close" ? "close" : "entry",
            sequence: 0,
        })
        await this.lifecycleManager.captureVenueUpdate(canonicalOrderId, normalizedResult, "status_change")
        return normalizedResult
    }

    async createExecutionOperationContext(
        intent: OrderIntent,
        action: SubmitOrderContext["identity"]["role"] | "adjustment"
    ): Promise<SubmitOrderContext> {
        return await this.createSubmitContext(intent, action)
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

function isDuplicateExposureRecoveryEvidence(evidence: Record<string, unknown> | undefined): boolean {
    if (!evidence) {
        return false
    }

    return evidence.outcome === "ambiguous" ||
        Array.isArray(evidence.matches) && evidence.matches.length > 1 ||
        Array.isArray(evidence.providerOrderAliases) && evidence.providerOrderAliases.length > 1
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

function readRecoveryProbeEvidence(result: ExecutionResult): Record<string, unknown> | undefined {
    const details = result.errorDetail?.details
    if (!details) {
        return undefined
    }

    const evidence = details.recovery
    return evidence && typeof evidence === "object" && !Array.isArray(evidence)
        ? evidence as Record<string, unknown>
        : details
}

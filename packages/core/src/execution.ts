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
    ExecutionOrderOperation,
    ExecutionOrderOperationLock,
    ExecutionSafetyFaultInput,
    ExecutionSafetyFaultRecorder,
    ExecutionPipelineConfig,
    OrderOperationContext,
    OrderStatusCallback,
    ProviderCloseStructureTarget,
    SubmitOrderContext,
    TradeEventLogger,
    VenueAdapter,
} from "./execution-contracts"
import {
    positionSideForOrderSide,
    withLifecycleAction,
} from "./execution-metadata"
import {
    createRejectedExecutionResultFromUnknownError,
    createUnconfirmedOperationFailureExecutionResult,
    mergeExecutionIntentUpdates,
    normalizeModifyExecutionResult,
    shouldPersistModifyIntentUpdates,
    toRecoverableOperationResult,
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
import { validateCloseIntentInventory } from "./execution-close-inventory"
import {
    reconcileOwnedInstrumentsFromSnapshots,
    updateOwnedInstrumentsFromResult,
} from "./execution-ownership"
import {
    createOrderOperationContext,
    resolveSnapshotPositionIdentity,
} from "./execution-order-operation-context"
import { resolveProviderPositionId } from "./provider-position-key"

export * from "./dry-run-ledger"
export * from "./price-verification"
export * from "./execution-identity-constants"
export * from "./execution-identity-shared"
export * from "./execution-submit-recovery"
export type {
    ClosePositionOptions,
    DryRunOrderSimulator,
    ExecuteIntentResult,
    ExecutionPipelineConfig,
    ExecutionSafetyFaultRecorder,
    OrderLifecycleConfig,
    ExecutionOrderOperation,
    ExecutionOrderOperationLock,
    OrderStatusCallback,
    OrderOperationContext,
    ProviderCloseStructureTarget,
    SingleLegCloseStructureResolutionInput,
    SubmitOrderContext,
    SubmitRecoveryResult,
    TradeEventLogger,
    VenueAdapter,
    ExecutionSafetyFaultInput,
} from "./execution-contracts"

const ALLOWED_VALIDATION: ValidationResult = { allowed: true }

const RUNTIME_DUPLICATE_ENTRY_WINDOW_MS = 15 * 60 * 1000

interface RuntimeEntryExposure {
    canonicalOrderId: string
    instrument: string
    heldSide: Position["side"]
    openedAt: number
}

type ModifyOrderDispatch = {
    providerId: string
    context: OrderOperationContext
    errorDetail?: undefined
} | {
    providerId?: undefined
    context?: undefined
    errorDetail: NonNullable<ExecutionResult["errorDetail"]>
}

function isSingleLegIntent(intent: OrderIntent): boolean {
    return !intent.legs || intent.legs.length === 0
}

function buildRuntimeEntryExposureKey(instrument: string, heldSide: Position["side"]): string {
    return `${instrument}:${heldSide}`
}

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
    private runtimeEntryExposures = new Map<string, RuntimeEntryExposure>()
    private executionSafetyFaultRecorder?: ExecutionSafetyFaultRecorder
    private orderOperationLock?: ExecutionOrderOperationLock
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
        this.orderOperationLock = config.orderOperationLock
        this.lifecycleManager = new OrderLifecycleManager(
            config.venue,
            config.logger,
            config.lifecycle,
            config.orderPersistence,
            config.tradeEventLogger,
            config.runId,
            config.strategyId,
            config.accountId,
            config.venueName,
            (previousSnapshot, currentSnapshot) => {
                reconcileOwnedInstrumentsFromSnapshots(this.ownedInstruments, previousSnapshot, currentSnapshot)
            },
            config.orderOperationLock
        )
    }

    async executeIntent(
        intent: OrderIntent,
        accountState: AccountState,
        positions: Position[],
        lifecycleContext: OrderLifecycleContext = { action: getIntentAction(intent) }
    ): Promise<ExecuteIntentResult> {
        return await this.runOrderOperation("executeIntent", async () =>
            await this.executeIntentWithoutOperationLock(intent, accountState, positions, lifecycleContext)
        )
    }

    private async executeIntentWithoutOperationLock(
        intent: OrderIntent,
        accountState: AccountState,
        positions: Position[],
        lifecycleContext: OrderLifecycleContext
    ): Promise<ExecuteIntentResult> {
        const intentWithLifecycleMetadata = withLifecycleAction(intent, lifecycleContext)

        this.logger.info("Order intent received", { intent: intentWithLifecycleMetadata, action: lifecycleContext.action })
        void this.tradeEventLogger?.logIntent(this.runId, this.strategyId, intentWithLifecycleMetadata)

        const commitUnknownBlockValidation = this.validateRuntimeCommitUnknownBlock(
            intentWithLifecycleMetadata,
            lifecycleContext.action
        )
        const runtimeBlockValidation = commitUnknownBlockValidation.allowed
            ? await this.validateRuntimeDuplicateEntryBlock(
                intentWithLifecycleMetadata,
                lifecycleContext.action
            )
            : commitUnknownBlockValidation
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
            this.rememberEntryExposure(finalIntent, lifecycleContext.action, mockResult)
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
        await this.recordMissingAccountingSafetyFaultIfNeeded(finalIntent, lifecycleContext.action, resultWithVerification)
        if (preparedHandle) {
            preparedHandle.snapshot = updatedSnapshot
        }
        this.rememberEntryExposure(finalIntent, lifecycleContext.action, resultWithVerification)
        updateOwnedInstrumentsFromResult(this.ownedInstruments, lifecycleContext.action, finalIntent.instrument, resultWithVerification)
        return { result: resultWithVerification, validation, handle: preparedHandle }
    }

    async cancelOrder(orderId: string, reason?: string): Promise<ExecutionResult> {
        return await this.runOrderOperation("cancelOrder", async () =>
            await this.cancelOrderWithoutOperationLock(orderId, reason)
        )
    }

    private async cancelOrderWithoutOperationLock(orderId: string, reason?: string): Promise<ExecutionResult> {
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
            result = createUnconfirmedOperationFailureExecutionResult(providerOrderId, error, existing)
        }
        result = toRecoverableOperationResult(normalizeExecutionResultIdentity(result, cancelIdentity))
        void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, result, intent)
        const updatedSnapshot = await this.lifecycleManager.captureVenueUpdate(canonicalOrderId, result, "cancel_attempt", reason)
        if (preparedHandle) {
            preparedHandle.snapshot = updatedSnapshot
        }
        return result
    }

    async modifyOrder(orderId: string, changes: Partial<OrderIntent>, reason?: string): Promise<ExecutionResult> {
        return await this.runOrderOperation("modifyOrder", async () =>
            await this.modifyOrderWithoutOperationLock(orderId, changes, reason)
        )
    }

    private async modifyOrderWithoutOperationLock(
        orderId: string,
        changes: Partial<OrderIntent>,
        reason?: string
    ): Promise<ExecutionResult> {
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

        const dispatch = await this.resolveModifyOrderDispatch(orderId, providerOrderId, existing)

        if (dispatch.errorDetail) {
            const validation: ValidationResult = {
                allowed: false,
                reason: dispatch.errorDetail.message,
            }
            const result = createModifyPreValidationResult(
                canonicalOrderId,
                existing,
                dispatch.errorDetail
            )

            void this.tradeEventLogger?.logValidation(this.runId, this.strategyId, validation, intent)
            void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, result, intent)
            return result
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
            result = await this.venue.modifyOrder(dispatch.providerId, changes, dispatch.context)
        } catch (error) {
            result = createUnconfirmedOperationFailureExecutionResult(dispatch.providerId, error, existing)
        }
        const identityNormalizedResult = toRecoverableOperationResult(normalizeExecutionResultIdentity(result, {
            canonicalOrderId,
            providerClientOrderId: existing?.providerClientOrderId ?? canonicalOrderId,
            providerOrderId,
            providerOrderAliases: existing?.providerOrderAliases ?? [],
            submitAttemptId: existing?.submitAttemptId ?? "",
            submitAttemptSequence: existing?.submitAttemptSequence ?? 1,
            commitOutcome: "accepted",
            venue: this.venueName,
            role: "modify",
            sequence: 0,
        }))
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

    private async resolveModifyOrderDispatch(
        requestedOrderId: string,
        providerOrderId: string,
        existing: OrderSnapshot | null
    ): Promise<ModifyOrderDispatch> {
        if (this.venueName !== "mt5") {
            return {
                providerId: providerOrderId,
                context: existing
                    ? createOrderOperationContext(existing)
                    : {
                        canonicalOrderId: requestedOrderId,
                        providerOrderId,
                    },
            }
        }

        if (!existing) {
            return {
                errorDetail: createExecutionErrorDetail(
                    "pre_validation",
                    "MT5 modify_order requires tracked canonical state to distinguish a working order from a live position",
                    {
                        code: "MT5_MODIFY_CANONICAL_STATE_MISSING",
                        retryable: false,
                        details: {
                            requestedOrderId,
                            providerOrderId,
                        },
                    }
                ),
            }
        }

        const context = createOrderOperationContext(existing)
        if (context.operationTarget === "working_order") {
            if (!existing.providerOrderId) {
                return {
                    errorDetail: createExecutionErrorDetail(
                        "pre_validation",
                        `MT5 working-order modify for ${existing.orderId} requires provider order identity`,
                        {
                            code: "MT5_MODIFY_ORDER_ID_MISSING",
                            retryable: false,
                            details: {
                                requestedOrderId,
                                canonicalOrderId: existing.orderId,
                            },
                        }
                    ),
                }
            }

            return {
                providerId: existing.providerOrderId,
                context,
            }
        }

        if (context.operationTarget === "position") {
            if (context.providerPositionId) {
                return {
                    providerId: context.providerPositionId,
                    context,
                }
            }

            return await this.resolveModifyPositionIdentityFromBook(requestedOrderId, existing, context)
        }

        return {
            errorDetail: createExecutionErrorDetail(
                "pre_validation",
                `MT5 modify_order target is ambiguous for ${existing.orderId} with lifecycle status ${existing.status}`,
                {
                    code: "MT5_MODIFY_TARGET_AMBIGUOUS",
                    retryable: false,
                    details: {
                        requestedOrderId,
                        canonicalOrderId: existing.orderId,
                        providerOrderId: existing.providerOrderId,
                        providerPositionId: context.providerPositionId,
                        orderStatus: existing.status,
                    },
                }
            ),
        }
    }

    private async resolveModifyPositionIdentityFromBook(
        requestedOrderId: string,
        existing: OrderSnapshot,
        context: OrderOperationContext
    ): Promise<ModifyOrderDispatch> {
        let positions: Position[]
        try {
            positions = await this.getPositions()
        } catch (error) {
            return {
                errorDetail: createExecutionErrorDetail(
                    "pre_validation",
                    `MT5 position stop update for ${existing.orderId} could not read the owned position book: ${getErrorMessage(error)}`,
                    {
                        code: "MT5_MODIFY_POSITION_BOOK_UNAVAILABLE",
                        retryable: true,
                        details: {
                            requestedOrderId,
                            canonicalOrderId: existing.orderId,
                            instrument: existing.instrument,
                        },
                    }
                ),
            }
        }

        const resolution = resolveSnapshotPositionIdentity({
            snapshot: existing,
            positions,
        })

        if (resolution.outcome === "ambiguous") {
            return {
                errorDetail: createExecutionErrorDetail(
                    "pre_validation",
                    `MT5 position stop update for ${existing.orderId} matched ${resolution.candidates.length} owned ${existing.instrument} ${resolution.heldSide} positions and cannot select one`,
                    {
                        code: "MT5_MODIFY_POSITION_AMBIGUOUS",
                        retryable: false,
                        details: {
                            requestedOrderId,
                            canonicalOrderId: existing.orderId,
                            instrument: existing.instrument,
                            heldSide: resolution.heldSide,
                            ownedQuantity: existing.filledQuantity,
                            providerPositionIds: resolution.candidates.map((position) =>
                                resolveProviderPositionId(position)
                            ),
                        },
                    }
                ),
            }
        }

        if (resolution.outcome === "not_found") {
            return {
                errorDetail: createExecutionErrorDetail(
                    "pre_validation",
                    `MT5 position stop update for ${existing.orderId} requires provider position identity`,
                    {
                        code: "MT5_MODIFY_POSITION_ID_MISSING",
                        retryable: false,
                        details: {
                            requestedOrderId,
                            canonicalOrderId: existing.orderId,
                            providerOrderId: existing.providerOrderId,
                            orderStatus: existing.status,
                            instrument: existing.instrument,
                            heldSide: resolution.heldSide,
                        },
                    }
                ),
            }
        }

        this.logger.info("Resolved MT5 position identity for stop update from the owned position book", {
            canonicalOrderId: existing.orderId,
            instrument: existing.instrument,
            heldSide: resolution.heldSide,
            providerPositionId: resolution.providerPositionId,
        })

        return {
            providerId: resolution.providerPositionId,
            context: {
                ...context,
                providerPositionId: resolution.providerPositionId,
            },
        }
    }

    async closePosition(
        instrument: string,
        reason?: string,
        options: ClosePositionOptions = {}
    ): Promise<ExecuteIntentResult> {
        return await this.runOrderOperation("closePosition", async () =>
            await this.closePositionWithoutOperationLock(instrument, reason, options)
        )
    }

    private async closePositionWithoutOperationLock(
        instrument: string,
        reason?: string,
        options: ClosePositionOptions = {},
        resolvedVenueIntent?: OrderIntent
    ): Promise<ExecuteIntentResult> {
        const positions = await this.getPositions()
        const position = positions.find((item) => item.instrument === instrument)
        const structureOwnershipFailure = await this.validateSingleLegCloseStructureOwnership(instrument, positions)
        if (structureOwnershipFailure) {
            const intent = buildClosePositionIntent({
                instrument,
                position,
                reason,
                options,
            })
            void this.tradeEventLogger?.logIntent(this.runId, this.strategyId, intent)
            void this.tradeEventLogger?.logValidation(this.runId, this.strategyId, structureOwnershipFailure.validation, intent)
            return createRejectedExecuteIntentResult(
                structureOwnershipFailure.validation,
                structureOwnershipFailure.errorDetail
            )
        }

        let venueIntent: OrderIntent | undefined = resolvedVenueIntent
        if (!venueIntent && !this.policy.dryRun && this.venue.buildCloseIntent) {
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
        const closeSide = intent.side

        this.logger.info("Closing position", { instrument, reason })
        void this.tradeEventLogger?.logIntent(this.runId, this.strategyId, intent)

        const inventoryFailure = await this.validateCloseInventory(intent)
        if (inventoryFailure) {
            void this.tradeEventLogger?.logValidation(this.runId, this.strategyId, inventoryFailure.validation, intent)
            return createRejectedExecuteIntentResult(
                inventoryFailure.validation,
                inventoryFailure.errorDetail
            )
        }

        void this.tradeEventLogger?.logValidation(this.runId, this.strategyId, ALLOWED_VALIDATION, intent)
        const submitContext = await this.createSubmitContext(intent, "close")

        if (this.policy.dryRun) {
            return await this.recordCloseResult({
                instrument,
                closeSide,
                quantity: intent.quantity,
                fallbackFillPrice: position?.currentPrice ?? position?.entryPrice ?? 0,
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
                    filledQuantity: intent.quantity,
                    fillPrice:
                        (intent.metadata?.estimatedPrice as number | undefined) ??
                        position?.currentPrice ??
                        position?.entryPrice ??
                        0,
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
            result = toRecoverableOperationResult(normalizeExecutionResultIdentity(result, submitContext.identity))
        }
        await this.recordCommitUnknownSafetyFaultIfNeeded(intent, "close", result)
        return await this.recordCloseResult({
            instrument,
            closeSide,
            quantity: intent.quantity,
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
        return await this.runOrderOperation("closeProviderPosition", async () =>
            await this.closeProviderPositionWithoutOperationLock(position, reason, options)
        )
    }

    private async closeProviderPositionWithoutOperationLock(
        position: Position,
        reason?: string,
        options: ClosePositionOptions = {}
    ): Promise<ExecuteIntentResult> {
        const claimInstruments = this.ownershipScope?.instruments ?? this.ownedInstruments
        if (!this.policy.dryRun && this.venue.resolveProviderCloseStructureTarget && claimInstruments) {
            const structureTarget = await this.venue.resolveProviderCloseStructureTarget(position, claimInstruments)
            if (structureTarget) {
                this.logger.info("Provider position close rerouted to claimed structure close", {
                    instrument: position.instrument,
                    claimInstrument: structureTarget.claimInstrument,
                    providerPositionId: position.providerPositionId,
                })
                const delegated = await this.closePositionWithoutOperationLock(
                    structureTarget.claimInstrument,
                    reason,
                    {
                        ...options,
                        estimatedPrice: undefined,
                    },
                    structureTarget.closeIntent
                )
                return {
                    ...delegated,
                    structureClose: structureTarget,
                }
            }
        }

        const closeSide = resolveCloseOrderSide(position)
        const intent = buildProviderPositionCloseIntent({ position, reason, options })

        this.logger.info("Closing provider position", {
            instrument: position.instrument,
            providerPositionId: position.providerPositionId,
            reason,
        })
        void this.tradeEventLogger?.logIntent(this.runId, this.strategyId, intent)

        const inventoryFailure = await this.validateCloseInventory(intent)
        if (inventoryFailure) {
            void this.tradeEventLogger?.logValidation(this.runId, this.strategyId, inventoryFailure.validation, intent)
            return createRejectedExecuteIntentResult(
                inventoryFailure.validation,
                inventoryFailure.errorDetail
            )
        }

        void this.tradeEventLogger?.logValidation(this.runId, this.strategyId, ALLOWED_VALIDATION, intent)
        const submitContext = await this.createSubmitContext(intent, "close")

        if (this.policy.dryRun) {
            return await this.recordCloseResult({
                instrument: position.instrument,
                closeSide,
                quantity: intent.quantity,
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
                    filledQuantity: intent.quantity,
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
            result = toRecoverableOperationResult(normalizeExecutionResultIdentity(result, submitContext.identity))
        }
        await this.recordCommitUnknownSafetyFaultIfNeeded(intent, "close", result)
        return await this.recordCloseResult({
            instrument: position.instrument,
            closeSide,
            quantity: intent.quantity,
            fallbackFillPrice: position.currentPrice ?? position.entryPrice,
            intent,
            reason,
            dryRun: false,
            result,
            preparedHandle,
        })
    }

    private async runOrderOperation<T>(
        operation: ExecutionOrderOperation,
        run: () => Promise<T>
    ): Promise<T> {
        return this.orderOperationLock
            ? await this.orderOperationLock(operation, run)
            : await run()
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

    private async validateCloseInventory(
        intent: OrderIntent
    ): Promise<ReturnType<typeof validateCloseIntentInventory>> {
        return validateCloseIntentInventory({
            intent,
            positions: await this.resolveCloseInventoryPositions(intent),
        })
    }

    private async validateSingleLegCloseStructureOwnership(
        instrument: string,
        positions: Position[]
    ): Promise<ReturnType<typeof validateCloseIntentInventory>> {
        const claimInstruments = this.ownershipScope?.instruments ?? this.ownedInstruments
        if (!claimInstruments || !this.venue.resolveSingleLegCloseStructureTarget) {
            return undefined
        }

        try {
            const structureTarget = await this.venue.resolveSingleLegCloseStructureTarget({
                instrument,
                claimInstruments,
                positions,
                allowProviderPositionRefresh: !this.policy.dryRun,
            })

            return structureTarget
                ? createSingleLegCloseClaimedStructureFailure(instrument, structureTarget)
                : undefined
        } catch (error) {
            const errorDetail = getExecutionErrorDetail(error) ?? createExecutionErrorDetail("internal", getErrorMessage(error))
            return {
                validation: {
                    allowed: false,
                    reason: errorDetail.message,
                },
                errorDetail,
            }
        }
    }

    private async resolveCloseInventoryPositions(intent: OrderIntent): Promise<Position[]> {
        const positions = await this.getPositions()
        if (
            positions.length > 0 ||
            !intent.legs ||
            intent.legs.length === 0 ||
            !this.ownedInstruments?.has(intent.instrument) ||
            this.ownershipScope
        ) {
            return positions
        }

        const legInstruments = new Set(intent.legs.map((leg) => leg.instrument))
        return (await this.venue.getPositions()).filter((position) =>
            legInstruments.has(position.instrument)
        )
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

    private rememberEntryExposure(
        intent: OrderIntent,
        action: OrderLifecycleContext["action"],
        result: ExecutionResult
    ): void {
        if (action !== "entry" || !isSingleLegIntent(intent)) {
            return
        }

        if (result.status !== "pending" && result.status !== "partially_filled" && result.status !== "filled") {
            return
        }

        const heldSide = positionSideForOrderSide(intent.side, true)
        this.runtimeEntryExposures.set(buildRuntimeEntryExposureKey(intent.instrument, heldSide), {
            canonicalOrderId: result.canonicalOrderId ?? result.orderId,
            instrument: intent.instrument,
            heldSide,
            openedAt: Date.now(),
        })
    }

    private async validateRuntimeDuplicateEntryBlock(
        intent: OrderIntent,
        action: OrderLifecycleContext["action"]
    ): Promise<ValidationResult> {
        if (action !== "entry" || !isSingleLegIntent(intent)) {
            return ALLOWED_VALIDATION
        }

        const heldSide = positionSideForOrderSide(intent.side, true)
        const exposureKey = buildRuntimeEntryExposureKey(intent.instrument, heldSide)
        const previous = this.runtimeEntryExposures.get(exposureKey)
        if (!previous) {
            return ALLOWED_VALIDATION
        }

        if (Date.now() - previous.openedAt > RUNTIME_DUPLICATE_ENTRY_WINDOW_MS) {
            this.runtimeEntryExposures.delete(exposureKey)
            return ALLOWED_VALIDATION
        }

        let providerPositions: Position[]
        try {
            providerPositions = this.dryRun
                ? this.dryRunBook.getPositions()
                : await this.venue.getPositions()
        } catch (error) {
            return {
                allowed: false,
                reason: `Entry ${previous.canonicalOrderId} already opened ${intent.instrument} ${heldSide} exposure in this run and provider position truth could not be read to confirm it is closed: ${getErrorMessage(error)}`,
            }
        }

        const liveExposure = providerPositions.some((position) =>
            position.instrument === previous.instrument && position.side === previous.heldSide
        )
        if (!liveExposure) {
            this.runtimeEntryExposures.delete(exposureKey)
            return ALLOWED_VALIDATION
        }

        return {
            allowed: false,
            reason: `Duplicate entry: ${previous.canonicalOrderId} already opened ${intent.instrument} ${heldSide} exposure in this run and provider truth still shows that position open. Close it or size in through an adjustment instead of re-entering.`,
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

    private async recordMissingAccountingSafetyFaultIfNeeded(
        intent: OrderIntent,
        action: OrderLifecycleContext["action"],
        result: ExecutionResult
    ): Promise<void> {
        if (result.status !== "filled" && result.status !== "partially_filled") {
            return
        }

        const metadata = result.intentUpdates?.metadata
        if (!metadata || metadata.providerAccountingMissing !== true) {
            return
        }

        const canonicalOrderId = result.canonicalOrderId ?? result.orderId
        const fault: ExecutionSafetyFaultInput = {
            strategyId: this.strategyId,
            runId: this.runId,
            venue: this.venueName,
            instrument: intent.instrument,
            canonicalOrderId,
            providerOrderId: result.providerOrderId,
            providerClientOrderId: result.providerClientOrderId,
            providerOrderAliases: result.providerOrderAliases,
            submitAttemptId: result.submitAttemptId,
            submitAttemptSequence: result.submitAttemptSequence,
            signedOrderFingerprint: result.signedOrderFingerprint,
            commitOutcome: result.commitOutcome ?? "accepted",
            category: "accounting_mismatch",
            message: `Provider accepted a filled ${action} order without provider accounting metadata`,
            providerPayload: JSON.stringify({
                action,
                result,
            }),
        }

        try {
            await this.executionSafetyFaultRecorder?.(fault)
        } catch (error) {
            const message = getErrorMessage(error)
            this.logger.error("Failed to persist missing-accounting execution safety fault", {
                instrument: intent.instrument,
                canonicalOrderId: fault.canonicalOrderId,
                submitAttemptId: fault.submitAttemptId,
                error: message,
            })
            throw createExecutionError(
                "internal",
                `Failed to persist missing-accounting execution safety fault for ${fault.canonicalOrderId}: ${message}`,
                {
                    code: "MISSING_ACCOUNTING_FAULT_PERSISTENCE_FAILED",
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
        return await this.runOrderOperation("refreshOrderStatus", async () =>
            await this.getOrderStatusWithoutOperationLock(orderId)
        )
    }

    private async getOrderStatusWithoutOperationLock(orderId: string): Promise<ExecutionResult> {
        const existing = await this.lifecycleManager.getOrderSnapshot(orderId)
        const canonicalOrderId = existing?.orderId ?? orderId
        const providerOrderId = existing?.providerOrderId ?? orderId
        const action = existing?.action === "close" ? "close" : "entry"
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
            role: action,
            sequence: 0,
        })
        await this.lifecycleManager.captureVenueUpdate(canonicalOrderId, normalizedResult, "status_change")
        await this.recordMissingAccountingSafetyFaultIfNeeded(
            existing?.intent ?? createSyntheticIntent(action, existing?.instrument ?? providerOrderId, "buy", 0, canonicalOrderId),
            action,
            normalizedResult
        )
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
        return await this.runOrderOperation("resumeOpenOrders", async () =>
            await this.lifecycleManager.resumeActiveOrders(onUpdate)
        )
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

function createSingleLegCloseClaimedStructureFailure(
    instrument: string,
    target: ProviderCloseStructureTarget
): NonNullable<ReturnType<typeof validateCloseIntentInventory>> {
    const normalizedInstrument = instrument.trim().toUpperCase()
    const instruction = `Use structure-close by submitting propose_close for ${target.claimInstrument}`
    const message = `Alpaca raw option leg close for ${normalizedInstrument} is rejected because the leg belongs to live claimed structure ${target.claimInstrument}. ${instruction}; do not submit single-leg closes for claimed structure legs.`
    const errorDetail = createExecutionErrorDetail("risk_engine", message, {
        code: "ALPACA_RAW_LEG_CLOSE_CLAIMED_STRUCTURE",
        retryable: false,
        details: {
            instrument: normalizedInstrument,
            claimInstrument: target.claimInstrument,
            legInstruments: target.legInstruments,
            instruction,
        },
    })

    return {
        validation: {
            allowed: false,
            reason: message,
        },
        errorDetail,
    }
}

function createModifyPreValidationResult(
    orderId: string,
    existing: OrderSnapshot | null,
    errorDetail: ReturnType<typeof createExecutionErrorDetail>
): ExecutionResult {
    return {
        orderId,
        status: existing?.status ?? "rejected",
        filledQuantity: existing?.filledQuantity ?? 0,
        fillPrice: existing?.avgFillPrice,
        timestamp: Date.now(),
        error: formatExecutionError(errorDetail),
        errorDetail,
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

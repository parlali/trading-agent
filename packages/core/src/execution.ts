import type {
    AccountState,
    ExecutionResult,
    OrderIntent,
    OrderLifecycleContext,
    Position,
    ValidationResult,
    WorkingOrder,
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
import {
    createExecutionErrorDetail,
    formatExecutionError,
    getErrorMessage,
    getExecutionErrorDetail,
} from "./utils"

export const DRY_RUN_ACCOUNT_LEDGER_INSTRUMENT = "__DRY_RUN_ACCOUNT_LEDGER__"

export function isDryRunAccountLedgerPosition(position: Pick<Position, "instrument">): boolean {
    return position.instrument === DRY_RUN_ACCOUNT_LEDGER_INSTRUMENT
}

export const PRICE_VERIFICATION_STATUSES = ["pass", "warn", "block", "skipped"] as const
export type PriceVerificationStatus = typeof PRICE_VERIFICATION_STATUSES[number]

export interface PriceVerificationLivePrices {
    bid?: number
    ask?: number
    mid?: number
    spread?: number
}

export interface PriceVerification {
    ok: boolean
    status?: PriceVerificationStatus
    livePrices: PriceVerificationLivePrices
    proposedPrice?: number
    drift?: number
    driftPercent?: number
    warningThresholdPercent?: number
    blockingThresholdPercent?: number
    message: string
    details?: Record<string, unknown>
}

export interface PriceVerifier {
    verify(intent: OrderIntent): Promise<PriceVerification>
}

export interface DryRunOrderSimulator {
    simulateDryRunOrder(intent: OrderIntent): Promise<ExecutionResult>
}

export interface VenueAdapter {
    getPositions(): Promise<Position[]>
    getAccountState(): Promise<AccountState>
    getWorkingOrders?(): Promise<WorkingOrder[]>
    submitOrder(intent: OrderIntent): Promise<ExecutionResult>
    cancelOrder(orderId: string): Promise<ExecutionResult>
    modifyOrder(orderId: string, changes: Partial<OrderIntent>): Promise<ExecutionResult>
    closePosition(instrument: string, preparedIntent?: OrderIntent): Promise<ExecutionResult>
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
}

export interface ExecuteIntentResult {
    result: ExecutionResult
    validation: ValidationResult
    handle?: TrackedOrderHandle
}

export interface ClosePositionOptions {
    estimatedPrice?: number
}

export interface OrderLifecycleConfig {
    pollInterval?: number
    timeout?: number
}

export interface PriceVerificationConfig {
    warningThresholdPercent?: number
    blockingThresholdPercent?: number
    failClosedOnVerificationError?: boolean
}

export type OrderStatusCallback = (
    update: OrderUpdateContext
) => OrderUpdateDecision | void | Promise<OrderUpdateDecision | void>

const ALLOWED_VALIDATION: ValidationResult = { allowed: true }
const DEFAULT_PRICE_VERIFICATION_CONFIG: Required<PriceVerificationConfig> = {
    warningThresholdPercent: 10,
    blockingThresholdPercent: 20,
    failClosedOnVerificationError: false,
}

export class ExecutionPipeline {
    private venue: VenueAdapter
    private venueName: string
    private policy: Record<string, unknown>
    private riskValidators: readonly RiskValidator[]
    private priceVerificationConfig: Required<PriceVerificationConfig>
    private logger: Logger
    private tradeEventLogger?: TradeEventLogger
    private lifecycleManager: OrderLifecycleManager
    private runId: string
    private strategyId: string
    private ownedInstruments: Set<string> | null
    private dryRun: boolean
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
        this.dryRun = Boolean(config.policy.dryRun)
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
        let result: ExecutionResult
        try {
            result = await this.venue.cancelOrder(orderId)
        } catch (error) {
            result = createRejectedExecutionResultFromUnknownError(orderId, error)
        }
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
        await this.lifecycleManager.recordModifyAttempt(orderId, changes, reason)

        if (this.policy.dryRun) {
            const result: ExecutionResult = {
                orderId,
                status: existing?.status ?? "pending",
                filledQuantity: existing?.filledQuantity ?? 0,
                fillPrice: existing?.avgFillPrice,
                timestamp: Date.now(),
                intentUpdates: changes,
            }
            void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, result, intent)
            await this.lifecycleManager.captureVenueUpdate(orderId, result, "modify_attempt", reason)
            return result
        }

        let result: ExecutionResult
        try {
            result = await this.venue.modifyOrder(orderId, changes)
        } catch (error) {
            result = createRejectedExecutionResultFromUnknownError(orderId, error, existing?.filledQuantity ?? 0, existing?.avgFillPrice)
        }
        const normalizedResult = normalizeModifyExecutionResult(result, existing, orderId)
        const resultWithIntentUpdates: ExecutionResult = {
            ...normalizedResult,
            intentUpdates: shouldPersistModifyIntentUpdates(result)
                ? mergeExecutionIntentUpdates(changes, result.intentUpdates)
                : undefined,
        }
        void this.tradeEventLogger?.logSubmission(this.runId, this.strategyId, resultWithIntentUpdates, intent)
        await this.lifecycleManager.captureVenueUpdate(orderId, resultWithIntentUpdates, "modify_attempt", reason)
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
        let intent: OrderIntent = {
            instrument,
            side: closeSide,
            quantity: position?.quantity ?? 0,
            orderType: "market",
            timeInForce: "day",
            metadata: {
                ...position?.metadata,
                action: "close",
                reason,
                estimatedPrice: options.estimatedPrice,
            },
        }

        if (position && !this.policy.dryRun && this.venue.buildCloseIntent) {
            let venueIntent: OrderIntent
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

            intent = {
                ...venueIntent,
                metadata: {
                    ...position.metadata,
                    ...venueIntent.metadata,
                    action: "close",
                    reason,
                    estimatedPrice: options.estimatedPrice ?? venueIntent.metadata?.estimatedPrice,
                },
            }
        }

        this.logger.info("Closing position", { instrument, reason })
        void this.tradeEventLogger?.logIntent(this.runId, this.strategyId, intent)

        if (!position) {
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
        return [
            ...Array.from(this.dryRunPositionBook.values()),
            this.createDryRunAccountLedgerPosition(),
        ]
    }

    async getAccountState(): Promise<AccountState> {
        if (this.dryRun) {
            return this.getDryRunAccountState()
        }

        return this.venue.getAccountState()
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
        const initialCash = typeof this.policy.dryRunInitialCash === "number"
            ? this.policy.dryRunInitialCash
            : typeof this.policy.virtualCash === "number"
                ? this.policy.virtualCash
                : 1000
        let currentValue = 0
        let marginUsed = 0
        let openPnl = 0

        for (const position of this.dryRunPositionBook.values()) {
            const mark = position.currentPrice ?? position.entryPrice
            const marketValue = position.quantity * mark
            currentValue += position.side === "short" ? -marketValue : marketValue
            marginUsed += Math.abs(marketValue)
            openPnl += position.unrealizedPnl ?? resolveDryRunUnrealizedPnl(
                position.side,
                position.quantity,
                position.entryPrice,
                mark
            ) ?? 0
        }

        const balance = initialCash + this.dryRunCashAdjustment
        const equity = balance + currentValue
        const dayPnl = this.dryRunRealizedPnl + openPnl

        return {
            balance,
            equity,
            buyingPower: Math.max(balance, 0),
            marginUsed,
            marginAvailable: Math.max(balance, 0),
            openPnl,
            dayPnl,
        }
    }

    private async runPriceVerification(intent: OrderIntent): Promise<PriceVerification | undefined> {
        if (!hasPriceVerifier(this.venue)) {
            return undefined
        }

        try {
            const verification = finalizePriceVerification(
                await this.venue.verify(intent),
                this.priceVerificationConfig
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
                }, this.priceVerificationConfig)

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
            }, this.priceVerificationConfig)

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
        const state = this.getDryRunAccountState()

        return {
            instrument: DRY_RUN_ACCOUNT_LEDGER_INSTRUMENT,
            side: "long",
            quantity: 0,
            entryPrice: 0,
            currentPrice: 0,
            unrealizedPnl: 0,
            metadata: {
                dryRunLedger: true,
                cashAdjustment: this.dryRunCashAdjustment,
                realizedPnl: this.dryRunRealizedPnl,
                balance: state.balance,
                equity: state.equity,
                openPnl: state.openPnl,
                dayPnl: state.dayPnl,
                sourceRunId: this.runId,
            },
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

function createRejectedExecutionResultFromUnknownError(
    orderId: string,
    error: unknown,
    filledQuantity: number = 0,
    fillPrice?: number
): ExecutionResult {
    const errorDetail = getExecutionErrorDetail(error) ?? createExecutionErrorDetail("internal", getErrorMessage(error))

    return {
        orderId,
        status: "rejected",
        filledQuantity,
        fillPrice,
        timestamp: Date.now(),
        error: formatExecutionError(errorDetail),
        errorDetail,
    }
}

function withLifecycleAction(intent: OrderIntent, lifecycleContext: OrderLifecycleContext): OrderIntent {
    if (!lifecycleContext.action || intent.metadata?.action) {
        return intent
    }

    return {
        ...intent,
        metadata: {
            ...intent.metadata,
            action: lifecycleContext.action,
            ...lifecycleContext.metadata,
        },
    }
}

function mergeExecutionIntentUpdates(
    requestedChanges: Partial<OrderIntent>,
    venueUpdates: Partial<OrderIntent> | undefined
): Partial<OrderIntent> {
    return {
        ...requestedChanges,
        ...venueUpdates,
        metadata: requestedChanges.metadata || venueUpdates?.metadata
            ? {
                ...requestedChanges.metadata,
                ...venueUpdates?.metadata,
            }
            : undefined,
    }
}

function shouldPersistModifyIntentUpdates(result: ExecutionResult): boolean {
    return (
        result.status === "pending" ||
        result.status === "partially_filled" ||
        result.status === "filled"
    )
}

function normalizeModifyExecutionResult(
    result: ExecutionResult,
    existing: OrderSnapshot | null,
    orderId: string
): ExecutionResult {
    if (!existing) {
        return {
            ...result,
            orderId: result.orderId || orderId,
        }
    }

    const preserveFilledState = existing.status === "filled" &&
        result.status === "filled" &&
        result.filledQuantity === 0 &&
        result.fillPrice === undefined

    return {
        ...result,
        orderId: result.orderId || orderId,
        status: preserveFilledState ? existing.status : result.status,
        filledQuantity: preserveFilledState
            ? existing.filledQuantity
            : result.filledQuantity,
        fillPrice: preserveFilledState
            ? existing.avgFillPrice
            : result.fillPrice ?? existing.avgFillPrice,
    }
}

function resolvePriceVerificationConfig(
    config: PriceVerificationConfig | undefined
): Required<PriceVerificationConfig> {
    const warningThresholdPercent = config?.warningThresholdPercent ?? DEFAULT_PRICE_VERIFICATION_CONFIG.warningThresholdPercent
    const blockingThresholdPercent = config?.blockingThresholdPercent ?? DEFAULT_PRICE_VERIFICATION_CONFIG.blockingThresholdPercent

    return {
        warningThresholdPercent,
        blockingThresholdPercent: Math.max(blockingThresholdPercent, warningThresholdPercent),
        failClosedOnVerificationError: config?.failClosedOnVerificationError ?? DEFAULT_PRICE_VERIFICATION_CONFIG.failClosedOnVerificationError,
    }
}

function hasPriceVerifier(venue: VenueAdapter): venue is VenueAdapter & PriceVerifier {
    return typeof (venue as Partial<PriceVerifier>).verify === "function"
}

function hasDryRunOrderSimulator(venue: VenueAdapter): venue is VenueAdapter & DryRunOrderSimulator {
    return typeof (venue as Partial<DryRunOrderSimulator>).simulateDryRunOrder === "function"
}

function resolveDryRunCurrentPrice(
    metadata?: Record<string, unknown>,
    result?: ExecutionResult
): number | undefined {
    if (typeof result?.priceVerification?.livePrices.mid === "number") {
        return result.priceVerification.livePrices.mid
    }

    if (typeof metadata?.currentPrice === "number") {
        return metadata.currentPrice
    }

    if (typeof metadata?.estimatedPrice === "number") {
        return metadata.estimatedPrice
    }

    return undefined
}

function resolveDryRunUnrealizedPnl(
    side: Position["side"],
    quantity: number,
    entryPrice: number,
    currentPrice?: number
): number | undefined {
    if (currentPrice === undefined) {
        return undefined
    }

    if (side === "short") {
        return quantity * (entryPrice - currentPrice)
    }

    return quantity * (currentPrice - entryPrice)
}

function resolveDryRunOpeningCashDelta(position: Position): number {
    const notional = position.quantity * position.entryPrice
    return position.side === "short" ? notional : -notional
}

function resolveDryRunCashDelta(
    side: "buy" | "sell",
    quantity: number,
    fillPrice: number
): number {
    const notional = quantity * fillPrice
    return side === "buy" ? -notional : notional
}

function resolveDryRunRealizedPnl(
    existing: Position,
    closeSide: "buy" | "sell",
    closedQty: number,
    fillPrice: number
): number {
    if (existing.side === "long" && closeSide === "sell") {
        return closedQty * (fillPrice - existing.entryPrice)
    }

    if (existing.side === "short" && closeSide === "buy") {
        return closedQty * (existing.entryPrice - fillPrice)
    }

    return 0
}

function orderSideForPositionSide(side: Position["side"]): "buy" | "sell" {
    return side === "long" ? "buy" : "sell"
}

function readNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value)
        ? value
        : undefined
}

function finalizePriceVerification(
    verification: PriceVerification,
    config: Required<PriceVerificationConfig>
): PriceVerification {
    const driftPercent = typeof verification.driftPercent === "number"
        ? Math.abs(verification.driftPercent)
        : undefined

    let status = verification.status ?? "pass"
    let ok = verification.ok

    if (!ok || status === "block") {
        status = "block"
        ok = false
    } else if (driftPercent !== undefined && driftPercent > config.blockingThresholdPercent) {
        status = "block"
        ok = false
    } else if (
        status !== "warn" &&
        driftPercent !== undefined &&
        driftPercent > config.warningThresholdPercent
    ) {
        status = "warn"
        ok = true
    }

    return {
        ...verification,
        ok,
        status,
        driftPercent,
        warningThresholdPercent: config.warningThresholdPercent,
        blockingThresholdPercent: config.blockingThresholdPercent,
        message: buildPriceVerificationMessage(
            verification,
            driftPercent,
            status,
            config
        ),
    }
}

function buildPriceVerificationMessage(
    verification: PriceVerification,
    driftPercent: number | undefined,
    status: PriceVerificationStatus,
    config: Required<PriceVerificationConfig>
): string {
    if (driftPercent === undefined) {
        return verification.message
    }

    const proposedPrice = verification.proposedPrice
    const liveMid = verification.livePrices.mid
    const drift = verification.drift

    if (verification.status === "block" || verification.ok === false) {
        return verification.message
    }

    const liveText = liveMid !== undefined ? `live mid ${liveMid}` : "live midpoint unavailable"
    const proposedText = proposedPrice !== undefined ? `proposed price ${proposedPrice}` : "no proposed price"
    const driftText = drift !== undefined ? `drift ${drift}` : "drift unavailable"

    if (status === "block") {
        return `Blocked by price verification: ${proposedText}, ${liveText}, ${driftText}, drift ${driftPercent.toFixed(2)}% exceeds ${config.blockingThresholdPercent}%`
    }

    if (status === "warn") {
        return `Price verification warning: ${proposedText}, ${liveText}, ${driftText}, drift ${driftPercent.toFixed(2)}% exceeds ${config.warningThresholdPercent}%`
    }

    return `Price verification passed: ${proposedText}, ${liveText}, ${driftText}, drift ${driftPercent.toFixed(2)}%`
}

function resolveIntentProposedPrice(intent: OrderIntent): number | undefined {
    if (typeof intent.limitPrice === "number") {
        return intent.limitPrice
    }

    if (typeof intent.stopPrice === "number") {
        return intent.stopPrice
    }

    const estimatedPrice = intent.metadata?.estimatedPrice
    return typeof estimatedPrice === "number" ? estimatedPrice : undefined
}

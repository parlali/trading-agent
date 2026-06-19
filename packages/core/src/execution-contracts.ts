import type {
    AccountState,
    AccountPnlEvent,
    ExecutionResult,
    ExecutionSafetyFaultCategory,
    OrderIntent,
    Position,
    ProviderPositionClosure,
    ValidationResult,
    WorkingOrder,
} from "./types"
import type {
    ExecutionCommitOutcome,
    ExecutionIdentityContext,
    PreparedExecutionIdentity,
    ProviderIdentityCapability,
} from "./execution-identity-constants"
import type {
    OrderPersistenceAdapter,
    OrderSnapshot,
    OrderUpdateDecision,
    OrderUpdateContext,
    TrackedOrderHandle,
} from "./orders"
import type { RiskValidator } from "./risk-types"
import type { ProviderOwnershipScope } from "./position-filter"
import type { Logger } from "./logger"
import type { PriceVerificationConfig } from "./price-verification-types"

export interface DryRunOrderSimulator {
    simulateDryRunOrder(intent: OrderIntent, context?: SubmitOrderContext): Promise<ExecutionResult>
}

export interface VenueAdapter {
    identityCapability?: ProviderIdentityCapability
    prepareOrderIdentity?(intent: OrderIntent, context: SubmitOrderContext): Promise<PreparedExecutionIdentity | undefined>
    classifySubmitError?(error: unknown, intent: OrderIntent, context: SubmitOrderContext): ExecutionCommitOutcome | undefined
    recoverSubmittedOrder?(intent: OrderIntent, context: SubmitOrderContext, error: unknown): Promise<SubmitRecoveryResult>
    getPositions(): Promise<Position[]>
    getAccountState(): Promise<AccountState>
    getWorkingOrders?(): Promise<WorkingOrder[]>
    getRecentPositionClosures?(): Promise<ProviderPositionClosure[]>
    getAccountPnlEvents?(): Promise<AccountPnlEvent[]>
    submitOrder(intent: OrderIntent, context?: SubmitOrderContext): Promise<ExecutionResult>
    cancelOrder(orderId: string, context?: OrderOperationContext): Promise<ExecutionResult>
    modifyOrder(orderId: string, changes: Partial<OrderIntent>, context?: OrderOperationContext): Promise<ExecutionResult>
    closePosition(instrument: string, preparedIntent?: OrderIntent, context?: SubmitOrderContext): Promise<ExecutionResult>
    closeProviderPosition?(position: Position, preparedIntent?: OrderIntent, context?: SubmitOrderContext): Promise<ExecutionResult>
    getOrderStatus(orderId: string): Promise<ExecutionResult>
    buildCloseIntent?(instrument: string): Promise<OrderIntent>
}

export interface SubmitOrderContext {
    identity: ExecutionIdentityContext
}

export interface OrderOperationContext {
    canonicalOrderId?: string
    providerOrderId?: string
    providerClientOrderId?: string
    providerOrderAliases?: string[]
    signedOrderFingerprint?: string
}

export type SubmitRecoveryResult =
    | {
        outcome: "accepted"
        result: ExecutionResult
    }
    | {
        outcome: "not_found" | "ambiguous"
        message: string
        matches?: ExecutionResult[]
        details?: Record<string, unknown>
    }

export interface TradeEventLogger {
    logIntent(runId: string, strategyId: string, intent: OrderIntent): Promise<void>
    logValidation(runId: string, strategyId: string, result: ValidationResult, intent: OrderIntent): Promise<void>
    logSubmission(runId: string, strategyId: string, result: ExecutionResult, intent: OrderIntent): Promise<void>
    logFillUpdate(runId: string, strategyId: string, result: ExecutionResult): Promise<void>
}

export interface ExecutionSafetyFaultInput {
    strategyId: string
    runId: string
    venue: string
    instrument: string
    canonicalOrderId: string
    providerOrderId?: string
    providerClientOrderId?: string
    providerOrderAliases?: string[]
    submitAttemptId?: string
    submitAttemptSequence?: number
    signedOrderFingerprint?: string
    commitOutcome: ExecutionCommitOutcome
    category?: ExecutionSafetyFaultCategory
    message: string
    recoveryProbeEvidence?: Record<string, unknown>
    providerPayload?: string
}

export type ExecutionSafetyFaultRecorder = (fault: ExecutionSafetyFaultInput) => Promise<void>
export type ExecutionOrderOperation =
    | "executeIntent"
    | "cancelOrder"
    | "modifyOrder"
    | "closePosition"
    | "closeProviderPosition"
    | "refreshOrderStatus"
    | "resumeOpenOrders"
    | "pollOrderStatus"
export type ExecutionOrderOperationLock = <T>(
    operation: ExecutionOrderOperation,
    run: () => Promise<T>
) => Promise<T>

export interface ExecutionPipelineConfig {
    venue: VenueAdapter
    venueName: string
    policy: Record<string, unknown>
    riskValidators?: readonly RiskValidator[]
    priceVerification?: PriceVerificationConfig
    logger: Logger
    tradeEventLogger?: TradeEventLogger
    orderPersistence?: OrderPersistenceAdapter
    executionSafetyFaultRecorder?: ExecutionSafetyFaultRecorder
    runId: string
    strategyId: string
    accountId?: string
    lifecycle?: OrderLifecycleConfig
    ownedInstruments?: Set<string>
    ownershipScope?: ProviderOwnershipScope
    strategyRealizedPnl?: number
    orderOperationLock?: ExecutionOrderOperationLock
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

export interface ClosePositionOptions {
    estimatedPrice?: number
    metadata?: Record<string, unknown>
}

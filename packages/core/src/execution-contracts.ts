import type {
    AccountState,
    ExecutionResult,
    OrderIntent,
    Position,
    ProviderPositionClosure,
    ValidationResult,
    WorkingOrder,
} from "./types"
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

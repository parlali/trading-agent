import type { App, VenueApp } from "./app-types"
import type { PriceVerification } from "./price-verification-types"
import type { OrderAction, OrderStatus } from "./order-types"
import type { OrderIntent, OrderSide } from "./order-intent-types"
import type {
    ExecutionCommitOutcome,
    ExecutionIdentityFields,
    ProviderIdentityCapability,
} from "./execution-identity-constants"

export {
    ACTIVE_VENUE_APPS,
    APPS,
    DEFAULT_APP_KILL_SWITCHES,
    VENUE_APPS,
    VENUE_KILL_SWITCH_KEYS,
    toVenueKillSwitchKey,
} from "./app-types"
export type {
    ActiveVenueApp,
    App,
    AppKillSwitches,
    VenueApp,
    VenueKillSwitchKey,
} from "./app-types"
export {
    ORDER_LEG_SIDES,
    ORDER_SIDES,
} from "./order-intent-types"
export {
    EXECUTION_COMMIT_OUTCOMES,
    EXECUTION_IDENTITY_VENUES,
    EXECUTION_ORDER_ROLES,
    PROVIDER_IDENTITY_CAPABILITIES,
} from "./execution-identity-constants"
export type {
    OrderIntent,
    OrderLeg,
    OrderLegSide,
    OrderSide,
} from "./order-intent-types"
export type {
    ExecutionCommitOutcome,
    ExecutionIdentityContext,
    ExecutionIdentityFields,
    ExecutionIdentityInput,
    ExecutionIdentityVenue,
    ExecutionOrderRole,
    PreparedExecutionIdentity,
    ProviderIdentityCapability,
} from "./execution-identity-constants"

export const SEVERITY_LEVELS = ["critical", "warning", "info"] as const
export type Severity = typeof SEVERITY_LEVELS[number]

export const EVENT_TYPES = [
    "intent",
    "validation",
    "submission",
    "fill_update",
    "filled",
    "rejected",
    "cancelled",
] as const
export type EventType = typeof EVENT_TYPES[number]

export const EXECUTION_ERROR_SOURCES = [
    "risk_engine",
    "pre_validation",
    "venue",
    "network",
    "timeout",
    "internal",
] as const
export type ExecutionErrorSource = typeof EXECUTION_ERROR_SOURCES[number]

export const STRATEGY_SAFETY_STATES = [
    "healthy",
    "cooldown",
    "execution_degraded",
    "blocked",
] as const
export type StrategySafetyState = typeof STRATEGY_SAFETY_STATES[number]

export const EXECUTION_SAFETY_FAULT_CATEGORIES = [
    "position_not_found_yet",
    "provider_rejected",
    "already_exists_conflict",
    "invalid_params",
    "commit_unknown",
    "duplicate_exposure",
    "unattributed_closure",
    "accounting_mismatch",
    "unknown",
] as const
export type ExecutionSafetyFaultCategory = typeof EXECUTION_SAFETY_FAULT_CATEGORIES[number]

export interface ExecutionResult extends ExecutionIdentityFields {
    orderId: string
    status: OrderStatus
    filledQuantity: number
    fillPrice?: number
    timestamp: number
    error?: string
    errorDetail?: ExecutionErrorDetail
    intentUpdates?: Partial<OrderIntent>
    priceVerification?: PriceVerification
}

export interface ExecutionErrorDetail {
    source: ExecutionErrorSource
    message: string
    code?: string
    retryable?: boolean
    details?: Record<string, unknown>
}

export interface Position {
    instrument: string
    providerPositionId?: string
    side: "long" | "short"
    quantity: number
    entryPrice: number
    currentPrice?: number
    unrealizedPnl?: number
    stopLoss?: number
    takeProfit?: number
    metadata?: Record<string, unknown>
}

export interface ProviderPositionClosure {
    instrument: string
    providerPositionId?: string
    side: "long" | "short"
    quantity: number
    fillPrice: number
    closedAt: number
    metadata?: Record<string, unknown>
}

export interface AccountPnlEvent {
    providerEventId: string
    eventType: "funding_fee" | "fee" | "adjustment"
    instrument?: string
    amount: number
    currency: string
    occurredAt: number
    metadata?: Record<string, unknown>
}

export interface AccountState {
    balance: number
    equity: number
    buyingPower: number
    marginUsed: number
    marginAvailable: number
    openPnl: number
    dayPnl: number
}

export interface WorkingOrder {
    orderId: string
    canonicalOrderId?: string
    providerOrderId?: string
    providerClientOrderId?: string
    providerOrderAliases?: string[]
    signedOrderFingerprint?: string
    instrument: string
    status: OrderStatus
    quantity: number
    filledQuantity: number
    remainingQuantity: number
    submittedAt: number
    updatedAt: number
    cancelAt?: number
    side?: OrderSide
    limitPrice?: number
    stopPrice?: number
    avgFillPrice?: number
    metadata?: Record<string, unknown>
}

export interface StrategyRunContext {
    runId: string
    strategyId: string
    app: App
    timestamp: number
    trigger: "cron" | "manual" | "callback" | "chat"
    positions: Position[]
    accountState: AccountState
    policy: Record<string, unknown>
    context: string
    runtimeContextLines?: string[]
    schedule?: string
    pendingOrders?: PendingOrderContext[]
    previousRunSummary?: {
        summary: string
        endedAt: number
        systemContextDigest?: RunSystemContextDigest
    }
    promptSanitizer?: PromptSanitizerContext
}

export interface PromptSanitizerContext {
    blockedIdentifiers: string[]
}

export interface PendingOrderContext {
    orderId: string
    instrument: string
    action: OrderAction
    status: OrderStatus
    quantity: number
    filledQuantity: number
    remainingQuantity: number
    submittedAt: number
    updatedAt: number
    cancelAt?: number
    limitPrice?: number
    avgFillPrice?: number
    recommendedAction: string
}

export interface RunSystemContextDigest {
    schemaVersion: 1
    generatedAt: number
    risk: {
        safetyState: StrategySafetyState
        dayRealizedPnl: number
        weekRealizedPnl: number
        dayDrawdownLimit?: number
        weekDrawdownLimit?: number
        cooldownActive: boolean
        cooldownReason?: StrategyRiskCooldownState["reason"]
        cooldownExpiresAt?: number
        blockedInstruments: string[]
        forcedExitClusterInstruments: string[]
        unresolvedExecutionFaultCount: number
    }
    recentTrades: {
        dayEntries: number
        dayCloses: number
        dayForcedExits: number
        dayRejectedOrTerminal: number
        weekRealizedPnl: number
        closeOutStreakDirection?: "win" | "loss"
        closeOutStreakCount: number
    }
    pendingOrders: Array<{
        orderId: string
        instrument: string
        action: OrderAction
        status: OrderStatus
        cancelAt?: number
    }>
}

export interface ValidationResult {
    allowed: boolean
    reason?: string
    adjustedIntent?: OrderIntent
}

export interface OrderLifecycleContext {
    action: OrderAction
    reason?: string
    metadata?: Record<string, unknown>
}

export const PROVIDER_OWNERSHIP_STATUSES = ["owned", "unowned", "orphaned"] as const
export type ProviderOwnershipStatus = typeof PROVIDER_OWNERSHIP_STATUSES[number]

export const PORTFOLIO_PROVIDER_STATUSES = ["healthy", "degraded", "stale"] as const
export type PortfolioProviderStatus = typeof PORTFOLIO_PROVIDER_STATUSES[number]

export interface PortfolioFreshness {
    app: VenueApp
    accountId: string
    accountScope: "account"
    lastSyncedAt?: number
    lastVerifiedAt?: number
    providerStatus: PortfolioProviderStatus
    stale: boolean
    driftDetected: boolean
    lastError?: string
    lastDriftSummary?: string
    positionCount: number
    pendingOrderCount: number
}

export interface PortfolioPosition extends Position {
    app: VenueApp
    accountId: string
    positionKey?: string
    strategyId?: string
    strategyName?: string
    ownershipStatus: ProviderOwnershipStatus
    expectedExternal?: boolean
    syncedAt: number
}

export interface PortfolioPendingOrder {
    app: VenueApp
    accountId: string
    strategyId?: string
    strategyName?: string
    ownershipStatus: ProviderOwnershipStatus
    expectedExternal?: boolean
    orderId: string
    canonicalOrderId?: string
    providerOrderId?: string
    providerClientOrderId?: string
    providerOrderAliases?: string[]
    signedOrderFingerprint?: string
    instrument: string
    venue: string
    status: OrderStatus
    action?: OrderAction
    quantity: number
    filledQuantity: number
    remainingQuantity: number
    side?: OrderSide
    limitPrice?: number
    stopPrice?: number
    avgFillPrice?: number
    submittedAt: number
    updatedAt: number
    cancelAt?: number
    metadata?: Record<string, unknown>
}

export interface StrategyRiskCooldownState {
    active: boolean
    reason?: "day_drawdown" | "week_drawdown" | "forced_exit_cluster" | "execution_fault"
    startedAt?: number
    expiresAt?: number
}

export interface StrategyDrawdownState {
    realizedPnl: number
    limit?: number
    progress?: number
}

export interface StrategyRiskState {
    strategyId: string
    app: VenueApp
    safetyState: StrategySafetyState
    day: StrategyDrawdownState
    week: StrategyDrawdownState
    cooldown: StrategyRiskCooldownState
    unresolvedExecutionFaultCount: number
    blockedInstruments: string[]
    forcedExitClusterInstruments: string[]
    lastUpdatedAt: number
}

export interface PortfolioTradeRow {
    eventId: string
    timestamp: number
    app: VenueApp
    strategyId: string
    strategyName: string
    runId: string
    orderId?: string
    instrument?: string
    eventType: EventType
    action?: OrderAction
    status?: OrderStatus
    side?: OrderSide
    quantity?: number
    filledQuantity?: number
    price?: number
    summary: string
}

export interface PortfolioEquityPoint {
    timestamp: number
    total: number
    providers: Partial<Record<VenueApp, number>>
}

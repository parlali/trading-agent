import type { PriceVerification } from "./execution"
import type { OrderAction, OrderStatus } from "./orders"

export const VENUE_APPS = ["alpaca-options", "polymarket", "mt5", "binance-futures"] as const
export const ACTIVE_VENUE_APPS = ["alpaca-options", "polymarket", "mt5"] as const
export type ActiveVenueApp = typeof ACTIVE_VENUE_APPS[number]
export type VenueApp = typeof VENUE_APPS[number]

export const APPS = [...VENUE_APPS, "backend"] as const
export type App = typeof APPS[number]

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

export const ORDER_SIDES = ["buy", "sell"] as const
export type OrderSide = typeof ORDER_SIDES[number]

export const EXECUTION_ERROR_SOURCES = [
    "risk_engine",
    "pre_validation",
    "venue",
    "network",
    "timeout",
    "internal",
] as const
export type ExecutionErrorSource = typeof EXECUTION_ERROR_SOURCES[number]

export const ORDER_LEG_SIDES = [
    "buy",
    "sell",
    "buy_to_open",
    "sell_to_open",
    "buy_to_close",
    "sell_to_close",
] as const
export type OrderLegSide = typeof ORDER_LEG_SIDES[number]

export interface OrderIntent {
    instrument: string
    side: OrderSide
    quantity: number
    orderType: "market" | "limit" | "stop" | "stop_limit"
    limitPrice?: number
    stopPrice?: number
    timeInForce: "day" | "gtc" | "ioc" | "fok"
    legs?: OrderLeg[]
    metadata?: Record<string, unknown>
}

export interface OrderLeg {
    instrument: string
    side: OrderLegSide
    quantity: number
    limitPrice?: number
}

export interface ExecutionResult {
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
    side: "long" | "short"
    quantity: number
    entryPrice: number
    currentPrice?: number
    unrealizedPnl?: number
    stopLoss?: number
    takeProfit?: number
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
    instrument: string
    status: OrderStatus
    quantity: number
    filledQuantity: number
    remainingQuantity: number
    submittedAt: number
    updatedAt: number
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
    trigger: "cron" | "manual" | "callback"
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
    }
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
    limitPrice?: number
    avgFillPrice?: number
    recommendedAction: string
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
    accountScope: "single-account-per-venue"
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

export interface PortfolioPosition {
    app: VenueApp
    strategyId?: string
    strategyName?: string
    ownershipStatus: ProviderOwnershipStatus
    instrument: string
    side: "long" | "short"
    quantity: number
    entryPrice: number
    currentPrice?: number
    unrealizedPnl?: number
    stopLoss?: number
    takeProfit?: number
    syncedAt: number
    metadata?: Record<string, unknown>
}

export interface PortfolioPendingOrder {
    app: VenueApp
    strategyId?: string
    strategyName?: string
    ownershipStatus: ProviderOwnershipStatus
    orderId: string
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
    metadata?: Record<string, unknown>
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

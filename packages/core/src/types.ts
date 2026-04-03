import type { OrderAction, OrderStatus } from "./orders"

export const VENUE_APPS = ["alpaca-options", "polymarket", "mt5"] as const
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

export interface OrderIntent {
    instrument: string
    side: "buy" | "sell"
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
    side: "buy" | "sell"
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
}

export interface Position {
    instrument: string
    side: "long" | "short"
    quantity: number
    entryPrice: number
    currentPrice?: number
    unrealizedPnl?: number
    metadata?: Record<string, unknown>
}

export interface AccountState {
    balance: number
    buyingPower: number
    marginUsed: number
    marginAvailable: number
    openPnl: number
    dayPnl: number
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
    schedule?: string
    previousRunSummary?: {
        summary: string
        endedAt: number
    }
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

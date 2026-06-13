import type { MutationCtx } from "../../_generated/server"
import type { Doc, Id } from "../../_generated/dataModel"

export type StrategyDoc = Doc<"strategies">
export type OrderDoc = Doc<"orders">
export type PortfolioMutationCtx = MutationCtx

export interface ResolvedOwnership {
    strategyId?: Id<"strategies">
    ownershipStatus: Doc<"provider_positions">["ownershipStatus"]
}

export interface ProviderPositionInput {
    instrument: string
    providerPositionId?: string
    side: "long" | "short"
    quantity: number
    entryPrice: number
    currentPrice?: number
    unrealizedPnl?: number
    stopLoss?: number
    takeProfit?: number
    metadata?: string
}

export interface ProviderWorkingOrderInput {
    orderId: string
    canonicalOrderId?: string
    providerOrderId?: string
    providerClientOrderId?: string
    providerOrderAliases?: string[]
    signedOrderFingerprint?: string
    instrument: string
    status: Doc<"orders">["status"]
    quantity: number
    filledQuantity: number
    remainingQuantity: number
    submittedAt: number
    updatedAt: number
    cancelAt?: number
    side?: "buy" | "sell"
    limitPrice?: number
    stopPrice?: number
    avgFillPrice?: number
    metadata?: string
}

export interface ProviderPositionClosureInput {
    instrument: string
    providerPositionId?: string
    side: "long" | "short"
    quantity: number
    fillPrice: number
    closedAt: number
    metadata?: string
}

export interface AccountPnlEventInput {
    providerEventId: string
    eventType: "funding_fee" | "fee" | "adjustment"
    instrument?: string
    amount: number
    currency: string
    occurredAt: number
    metadata?: string
}

export interface ReconciliationWriteStats {
    inserted: number
    patched: number
    deleted: number
    unchanged: number
}

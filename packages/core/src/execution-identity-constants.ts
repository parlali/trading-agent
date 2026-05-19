import type { OrderIntent } from "./order-intent-types"
import type { OrderAction } from "./order-types"

export const PROVIDER_IDENTITY_CAPABILITIES = [
    "native_client_id",
    "deterministic_signed_id",
    "provider_id_only",
] as const

export type ProviderIdentityCapability = typeof PROVIDER_IDENTITY_CAPABILITIES[number]

export const EXECUTION_COMMIT_OUTCOMES = [
    "accepted",
    "rejected",
    "commit_unknown",
    "recovered",
] as const

export type ExecutionCommitOutcome = typeof EXECUTION_COMMIT_OUTCOMES[number]

export const EXECUTION_IDENTITY_VENUES = [
    "mt5",
    "alpaca-options",
    "okx-swap",
    "polymarket",
] as const

export type ExecutionIdentityVenue = typeof EXECUTION_IDENTITY_VENUES[number]

export const EXECUTION_ORDER_ROLES = [
    "entry",
    "close",
    "modify",
    "cancel",
    "take_profit",
    "stop_loss",
] as const

export type ExecutionOrderRole = typeof EXECUTION_ORDER_ROLES[number]

export interface ExecutionIdentityInput {
    venue: string
    strategyId: string
    runId: string
    role: ExecutionOrderRole | OrderAction
    instrument: string
    normalizedIntent: unknown
    sequence?: number
    attemptSequence?: number
}

export interface ExecutionIdentityContext {
    canonicalOrderId: string
    providerClientOrderId: string
    providerOrderId?: string
    providerOrderAliases: string[]
    submitAttemptId: string
    submitAttemptSequence: number
    commitOutcome: ExecutionCommitOutcome
    signedOrderFingerprint?: string
    signedOrderMetadata?: Record<string, unknown>
    venue: string
    role: ExecutionOrderRole
    sequence: number
}

export interface PreparedExecutionIdentity extends Partial<ExecutionIdentityContext> {
    providerClientOrderId?: string
    signedOrderFingerprint?: string
    signedOrderMetadata?: Record<string, unknown>
}

export interface ExecutionIdentityFields {
    canonicalOrderId?: string
    providerOrderId?: string
    providerClientOrderId?: string
    providerOrderAliases?: string[]
    submitAttemptId?: string
    submitAttemptSequence?: number
    commitOutcome?: ExecutionCommitOutcome
    signedOrderFingerprint?: string
    signedOrderMetadata?: Record<string, unknown>
}

export const EXECUTION_IDENTITY_VENUE_CODES: Record<string, string> = {
    mt5: "mt",
    alpaca: "al",
    "alpaca-options": "al",
    okx: "ok",
    "okx-swap": "ok",
    polymarket: "pm",
}

export const EXECUTION_IDENTITY_ROLE_CODES: Record<ExecutionOrderRole | OrderAction, string> = {
    entry: "e",
    adjustment: "e",
    close: "c",
    modify: "m",
    cancel: "x",
    take_profit: "t",
    stop_loss: "s",
}

export const EXECUTION_IDENTITY_BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"

export const EXECUTION_IDENTITY_VOLATILE_METADATA_KEYS = new Set([
    "submitAttemptSequence",
    "cancelAt",
    "estimatedPrice",
    "fundingRate",
    "estimatedRoundTripFees",
    "riskAmount",
    "riskPercent",
])

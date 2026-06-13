import type { ToolBinding } from "@valiq-trading/agent"
import type { AccountState, Logger, Position, RiskValidator, VenueAdapter, VenueApp, WorkingOrder } from "@valiq-trading/core"
import type { App } from "@valiq-trading/core"
import type { AuditedSessionFlatResult } from "./session-flat"

export type { VenueApp } from "@valiq-trading/core"

export interface VenuePlugin {
    readonly app: VenueApp
    readonly venueName: string

    resolveSecretKeys(): string[]
    resolveAdditionalSecretKeys?(policy: Record<string, unknown>): string[]

    validateEnvironment(secrets: Record<string, string | null>): Promise<void>

    createVenueAdapter(
        policy: Record<string, unknown>,
        secrets: Record<string, string | null>
    ): VenueAdapter

    getRiskValidators(): readonly RiskValidator[]

    getExtraTools(config: ExtraToolsConfig): ToolBinding[]

    preRunHooks?(config: PreRunHookConfig): Promise<PreRunHookResult>

    postRunHooks?(config: PostRunHookConfig): Promise<void>
}

export interface ExtraToolsConfig {
    secrets: Record<string, string | null>
    runLogger: Logger
}

export interface PreRunHookConfig {
    venue: VenueAdapter
    policy: Record<string, unknown>
    strategyId: string
    ownedInstruments: Set<string>
    ownedPositions: Position[]
    ownedWorkingOrders: WorkingOrder[]
    strategyAccountState: AccountState
    logger: Logger
    createAlert(alert: { strategyId?: string; app: App; severity: "critical" | "warning" | "info"; message: string }): Promise<void>
    sessionFlat?: {
        execute(args: {
            positions: Position[]
            workingOrders: WorkingOrder[]
            reason: string
        }): Promise<AuditedSessionFlatResult>
    }
}

export interface PreRunHookResult {
    skip: boolean
    reason?: string
    runtimeContextLines?: string[]
    providerStateChanged?: boolean
}

export interface PostRunHookConfig {
    venue: VenueAdapter
    policy: Record<string, unknown>
    strategyId: string
    logger: Logger
    createAlert(alert: { strategyId?: string; app: App; severity: "critical" | "warning" | "info"; message: string }): Promise<void>
}

export interface HealthState {
    ready: boolean
    startedAt: number
    strategyCount: number
    venues: Record<string, VenueHealthState>
    lastRunAt?: number
    lastRunStatus?: "completed" | "failed"
    lastRunSummary?: string
    lastRunError?: string
}

export interface VenueHealthState {
    validated: boolean
    environment?: string
    error?: string
    accounts?: Record<string, AccountHealthState>
    lastSyncAt?: number
    lastVerifiedAt?: number
    providerStatus?: "healthy" | "degraded" | "stale"
    stale?: boolean
    driftDetected?: boolean
    positionCount?: number
    pendingOrderCount?: number
    lastSyncError?: string
}

export interface AccountHealthState {
    label?: string
    validated: boolean
    error?: string
    lastValidatedAt?: number
    lastSyncAt?: number
    lastVerifiedAt?: number
    providerStatus?: "healthy" | "degraded" | "stale"
    stale?: boolean
    driftDetected?: boolean
    positionCount?: number
    pendingOrderCount?: number
    lastSyncError?: string
}

import { ConvexHttpClient } from "convex/browser"
import { api } from "../convex/_generated/api"
import type { Id } from "../convex/_generated/dataModel"
import type {
    AccountState,
    App,
    ExecutionResult,
    OrderIntent,
    OrderLifecycleAlert,
    OrderPersistenceAdapter,
    OrderSnapshot,
    OrderTransition,
    Position,
    StrategyConfig,
    TradeEventLogger,
    ValidationResult,
    WorkingOrder,
} from "@valiq-trading/core"
import { withTimeout } from "@valiq-trading/core"

export { api }
export type { Id } from "../convex/_generated/dataModel"

// Re-declare TradeEventLogger methods inline to avoid type resolution cascade issues.
// The canonical definition lives in @valiq-trading/core; this mirrors it for the client interface.
interface TradeEventLoggerMethods {
    logIntent(runId: string, strategyId: string, intent: OrderIntent): Promise<void>
    logValidation(runId: string, strategyId: string, result: ValidationResult, intent: OrderIntent): Promise<void>
    logSubmission(runId: string, strategyId: string, result: ExecutionResult, intent: OrderIntent): Promise<void>
    logFillUpdate(runId: string, strategyId: string, result: ExecutionResult): Promise<void>
}

export interface ConvexOrderPersistenceConfig {
    url: string
    machineAuth?: {
        serviceToken: string
    }
    timeoutMs?: number
}

export interface TradingBackendClientConfig {
    url: string
    machineAuth?: {
        serviceToken: string
    }
    timeoutMs?: number
}

export interface StoredStrategy {
    _id: Id<"strategies">
    _creationTime: number
    app: Exclude<App, "backend">
    name: string
    enabled: boolean
    schedule: string
    policy: Record<string, unknown>
    context: string
    createdAt?: number
    updatedAt?: number
}

export type RunTrigger = "cron" | "manual" | "callback"

export interface StoredRun {
    _id: Id<"strategy_runs">
    _creationTime: number
    strategyId: Id<"strategies">
    app: App
    status: "running" | "completed" | "failed"
    trigger?: RunTrigger
    startedAt: number
    endedAt?: number
    summary?: string
    error?: string
    callbackRequestedMinutes?: number
    callbackFiresAt?: number
}

export interface KillSwitchState {
    globalKillSwitch: boolean
    appKillSwitches: Record<string, boolean>
    updatedAt: number
}

export function toKillSwitchKey(app: string): string {
    return app.replace(/-/g, "_")
}

export interface ManualRunRequest {
    _id: Id<"manual_run_requests">
    _creationTime: number
    strategyId: Id<"strategies">
    app: Exclude<App, "backend">
    requestedAt: number
    claimedBy?: string
    leaseExpiresAt?: number
    attemptCount: number
    lastError?: string
    terminalAt?: number
}

export interface ClaimedManualRunRequest {
    _id: Id<"manual_run_requests">
    strategyId: Id<"strategies">
    app: Exclude<App, "backend">
    requestedAt: number
    attemptCount: number
    leaseExpiresAt: number
}

export interface CascadeDeleteCounts {
    runs: number
    agentLogs: number
    tradeEvents: number
    orders: number
    orderTransitions: number
    positions: number
    instrumentClaims: number
    positionSyncs: number
    providerPositions: number
    providerWorkingOrders: number
    providerSyncStates: number
    accountSnapshots: number
    appHeartbeats: number
    manualRunRequests: number
    alerts: number
}

export interface DeleteStrategyResult extends CascadeDeleteCounts {}

export interface DeleteStrategyBatchResult extends CascadeDeleteCounts {
    strategyDeleted: boolean
    hasMore: boolean
}

export interface DeleteAllStrategiesResult extends CascadeDeleteCounts {
    strategies: number
}

export interface FullResetAudit extends DeleteAllStrategiesResult {}

export interface ControlPlaneMetricRow {
    _id: Id<"control_plane_metrics">
    _creationTime: number
    metric: string
    app?: App
    value: number
    updatedAt: number
}

export interface DeleteOrphanedStrategyHistoryBatchResult extends CascadeDeleteCounts {
    hasMore: boolean
}

export interface ClearFullResetStateBatchResult extends CascadeDeleteCounts {
    hasMore: boolean
}

export interface ReplaceAllStrategiesResult {
    importedStrategies: number
    deleted: DeleteAllStrategiesResult
}

export interface AdoptProviderPositionsResult {
    adoptedPositions: number
    adoptedOrders: number
}

export interface ProviderPortfolioReconciliationResult {
    app: Exclude<App, "backend">
    source: "startup_sync" | "periodic_sync" | "post_run_sync"
    positionCount: number
    pendingOrderCount: number
    driftDetected: boolean
    driftSummary?: string
}

export interface PortfolioFreshnessRow {
    app: Exclude<App, "backend">
    accountScope: "single-account-per-venue"
    lastSyncedAt?: number
    lastVerifiedAt?: number
    providerStatus: "healthy" | "degraded" | "stale"
    stale: boolean
    driftDetected: boolean
    lastError?: string
    lastDriftSummary?: string
    positionCount: number
    pendingOrderCount: number
}

export interface ProviderPositionRow {
    app: Exclude<App, "backend">
    strategyId?: string
    strategyName?: string
    ownershipStatus: "owned" | "unowned" | "orphaned"
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

export interface ProviderPendingOrderRow {
    app: Exclude<App, "backend">
    strategyId?: string
    strategyName?: string
    ownershipStatus: "owned" | "unowned" | "orphaned"
    orderId: string
    instrument: string
    venue: string
    status: OrderSnapshot["status"]
    action?: OrderSnapshot["action"]
    quantity: number
    filledQuantity: number
    remainingQuantity: number
    side?: "buy" | "sell"
    limitPrice?: number
    stopPrice?: number
    avgFillPrice?: number
    submittedAt: number
    updatedAt: number
    metadata?: Record<string, unknown>
}

export interface TradingBackendClient extends TradeEventLoggerMethods {
    getStrategyConfigs(app: App): Promise<StoredStrategy[]>
    getStrategyById(id: Id<"strategies">): Promise<StoredStrategy | null>
    getActiveRun(strategyId: Id<"strategies">): Promise<StoredRun | null>
    getLastCompletedRunSummary(strategyId: Id<"strategies">): Promise<{ summary: string; endedAt: number } | null>
    recoverRunningRuns(): Promise<number>
    recoverStaleRunningRuns(olderThanMs?: number): Promise<number>
    createRun(strategyId: Id<"strategies">, app: App, trigger?: RunTrigger): Promise<Id<"strategy_runs">>
    updateRun(runId: Id<"strategy_runs">, status: StoredRun["status"], summary?: string, error?: string): Promise<void>
    recordRunCallback(runId: Id<"strategy_runs">, callbackRequestedMinutes: number, callbackFiresAt: number): Promise<void>
    syncPositions(strategyId: Id<"strategies">, app: App, positions: Position[]): Promise<void>
    reconcileProviderPortfolio(
        app: Exclude<App, "backend">,
        venue: string,
        source: ProviderPortfolioReconciliationResult["source"],
        accountState: AccountState,
        positions: Position[],
        workingOrders: WorkingOrder[]
    ): Promise<ProviderPortfolioReconciliationResult>
    recordProviderSyncFailure(app: Exclude<App, "backend">, error: string): Promise<void>
    log(
        runId: string,
        strategyId: string,
        sequence: number,
        role: string,
        content: string,
        toolName?: string,
        toolInput?: string,
        toolOutput?: string
    ): Promise<void>
    resolveSecrets(keys: string[]): Promise<Record<string, string | null>>
    reportHeartbeatLiveness(
        app: App,
        status: "healthy" | "degraded" | "unhealthy",
        metadata?: Record<string, unknown>
    ): Promise<void>
    reportHeartbeatSnapshot(args: {
        app: App
        status: "healthy" | "degraded" | "unhealthy"
        metadata: Record<string, unknown>
        force?: boolean
    }): Promise<{
        written: boolean
        suppressed: boolean
        metadataHash: string
        lastSnapshotAt: number
        suppressedWrites: number
    }>
    reportHeartbeat(app: App, status: "healthy" | "degraded" | "unhealthy", metadata?: Record<string, unknown>): Promise<void>
    snapshotAccountState(app: App, venue: string, state: AccountState): Promise<void>
    getSystemState(): Promise<KillSwitchState>
    getControlPlaneMetrics(): Promise<ControlPlaneMetricRow[]>
    getPortfolioFreshness(app?: Exclude<App, "backend">): Promise<PortfolioFreshnessRow[]>
    getPortfolioPositions(app?: Exclude<App, "backend">, strategyId?: Id<"strategies">): Promise<ProviderPositionRow[]>
    getPortfolioPendingOrders(app?: Exclude<App, "backend">, strategyId?: Id<"strategies">): Promise<ProviderPendingOrderRow[]>
    adoptProviderPositions(
        app: Exclude<App, "backend">,
        strategyId: Id<"strategies">,
        instruments: string[]
    ): Promise<AdoptProviderPositionsResult>
    getManualRunRequests(app: Exclude<App, "backend">): Promise<ManualRunRequest[]>
    claimManualRunRequests(args: {
        app: Exclude<App, "backend">
        workerId: string
        leaseMs?: number
        maxClaims?: number
        maxAttempts?: number
    }): Promise<{
        app: Exclude<App, "backend">
        claimed: ClaimedManualRunRequest[]
        contentionCount: number
        terminalizedCount: number
        maxAttempts: number
        leaseMs: number
    }>
    ackManualRunRequest(args: {
        requestId: Id<"manual_run_requests">
        workerId: string
        outcome: "completed" | "requeue" | "retryable_failure" | "terminal_failure"
        error?: string
        maxAttempts?: number
    }): Promise<{ status: "missing" | "already_terminal" | "completed" | "requeue" | "retryable_failure" | "terminal_failure" }>
    clearManualRunRequest(requestId: Id<"manual_run_requests">): Promise<void>
    createAlert(args: { strategyId?: string; app?: App; severity: "critical" | "warning" | "info"; message: string }): Promise<void>
    triggerManualRun(strategyId: Id<"strategies">): Promise<Id<"manual_run_requests">>
    acknowledgeAlert(alertId: Id<"alerts">): Promise<void>
    getStrategyOwnedInstruments(strategyId: Id<"strategies">): Promise<string[]>
    getAllOwnedInstrumentsByApp(app: Exclude<App, "backend">): Promise<Array<{ instrument: string, strategyId: string }>>
    getLatestPositions(strategyId: Id<"strategies">): Promise<Position[]>
    getAllStrategies(): Promise<StoredStrategy[]>
    addStrategy(config: StrategyConfig): Promise<Id<"strategies">>
    disableStrategy(id: Id<"strategies">): Promise<void>
    deleteStrategy(id: Id<"strategies">): Promise<DeleteStrategyResult>
    deleteStrategyBatch(id: Id<"strategies">, batchSize?: number): Promise<DeleteStrategyBatchResult>
    deleteAllStrategies(): Promise<DeleteAllStrategiesResult>
    deleteOrphanedStrategyHistoryBatch(batchSize?: number): Promise<DeleteOrphanedStrategyHistoryBatchResult>
    clearFullResetState(): Promise<CascadeDeleteCounts>
    clearFullResetStateBatch(
        batchSize?: number,
        preserveApps?: App[]
    ): Promise<ClearFullResetStateBatchResult>
    getFullResetAudit(): Promise<FullResetAudit>
    replaceAllStrategies(strategies: StrategyConfig[]): Promise<ReplaceAllStrategiesResult>
}

export const createTradingBackendClient = (config: string | TradingBackendClientConfig): TradingBackendClient => {
    const resolvedConfig =
        typeof config === "string"
            ? { url: config }
            : config
    const client = new ConvexHttpClient(resolvedConfig.url)
    const timeoutMs = resolvedConfig.timeoutMs ?? 30_000

    const requireMachineAuth = (): { serviceToken: string } => {
        const serviceToken = resolvedConfig.machineAuth?.serviceToken?.trim()

        if (!serviceToken) {
            throw new Error("Machine-authenticated Convex call requires a backend service token")
        }

        return { serviceToken }
    }

    const runWithTimeout = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
        return await withTimeout(operation, timeoutMs, name)
    }

    return {
        async getStrategyConfigs(app: App): Promise<StoredStrategy[]> {
            return await runWithTimeout(
                "Convex query getStrategyConfigs",
                async () => await client.query(api.queries.getStrategyConfigs, { ...requireMachineAuth(), app } as never) as StoredStrategy[]
            )
        },
        async getStrategyById(id: Id<"strategies">): Promise<StoredStrategy | null> {
            return await runWithTimeout(
                "Convex query getStrategyById",
                async () => await client.query(api.queries.getStrategyById, { ...requireMachineAuth(), id } as never) as StoredStrategy | null
            )
        },
        async getActiveRun(strategyId: Id<"strategies">): Promise<StoredRun | null> {
            return await runWithTimeout(
                "Convex query getActiveRun",
                async () => await client.query(api.queries.getActiveRun, {
                    ...requireMachineAuth(),
                    strategyId,
                } as never) as StoredRun | null
            )
        },
        async getLastCompletedRunSummary(strategyId: Id<"strategies">): Promise<{ summary: string; endedAt: number } | null> {
            return await runWithTimeout(
                "Convex query getLastCompletedRunSummary",
                async () => await client.query(api.queries.getLastCompletedRunSummary, { ...requireMachineAuth(), strategyId } as never) as { summary: string; endedAt: number } | null
            )
        },
        async recoverRunningRuns(): Promise<number> {
            const result = await runWithTimeout(
                "Convex mutation recoverRunningRuns",
                async () => await client.mutation(api.mutations.recoverRunningRuns, {
                    ...requireMachineAuth(),
                } as never) as { recovered: number }
            )

            return result.recovered
        },
        async recoverStaleRunningRuns(olderThanMs?: number): Promise<number> {
            const result = await runWithTimeout(
                "Convex mutation recoverStaleRunningRuns",
                async () => await client.mutation(api.mutations.recoverStaleRunningRuns, {
                    ...requireMachineAuth(),
                    olderThanMs,
                } as never) as { recovered: number }
            )

            return result.recovered
        },
        async createRun(strategyId: Id<"strategies">, app: App, trigger?: RunTrigger): Promise<Id<"strategy_runs">> {
            return await runWithTimeout(
                "Convex mutation createRun",
                async () => await client.mutation(api.mutations.createRun, {
                    ...requireMachineAuth(),
                    strategyId,
                    app,
                    trigger,
                } as never) as Id<"strategy_runs">
            )
        },
        async recordRunCallback(
            runId: Id<"strategy_runs">,
            callbackRequestedMinutes: number,
            callbackFiresAt: number
        ): Promise<void> {
            await runWithTimeout(
                "Convex mutation recordRunCallback",
                async () => await client.mutation(api.mutations.recordRunCallback, {
                    ...requireMachineAuth(),
                    runId,
                    callbackRequestedMinutes,
                    callbackFiresAt,
                } as never)
            )
        },
        async updateRun(
            runId: Id<"strategy_runs">,
            status: StoredRun["status"],
            summary?: string,
            error?: string
        ): Promise<void> {
            await runWithTimeout(
                "Convex mutation updateRun",
                async () => await client.mutation(api.mutations.updateRun, {
                    ...requireMachineAuth(),
                    runId,
                    status,
                    summary,
                    error,
                })
            )
        },
        async log(
            runId: string,
            strategyId: string,
            sequence: number,
            role: string,
            content: string,
            toolName?: string,
            toolInput?: string,
            toolOutput?: string
        ): Promise<void> {
            if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
                throw new Error(`Unsupported agent log role: ${role}`)
            }

            await runWithTimeout(
                "Convex mutation logAgentMessage",
                async () => await client.mutation(api.mutations.logAgentMessage, {
                    ...requireMachineAuth(),
                    runId: runId as Id<"strategy_runs">,
                    strategyId: strategyId as Id<"strategies">,
                    sequence,
                    role,
                    content,
                    toolName,
                    toolInput,
                    toolOutput,
                })
            )
        },
        async logIntent(runId: string, strategyId: string, intent: OrderIntent): Promise<void> {
            await runWithTimeout(
                "Convex mutation logTradeEvent(intent)",
                async () => await client.mutation(api.mutations.logTradeEvent, {
                    ...requireMachineAuth(),
                    runId: runId as Id<"strategy_runs">,
                    strategyId: strategyId as Id<"strategies">,
                    eventType: "intent",
                    payload: JSON.stringify(intent),
                })
            )
        },
        async logValidation(
            runId: string,
            strategyId: string,
            result: ValidationResult,
            intent: OrderIntent
        ): Promise<void> {
            await runWithTimeout(
                "Convex mutation logTradeEvent(validation)",
                async () => await client.mutation(api.mutations.logTradeEvent, {
                    ...requireMachineAuth(),
                    runId: runId as Id<"strategy_runs">,
                    strategyId: strategyId as Id<"strategies">,
                    eventType: result.allowed ? "validation" : "rejected",
                    payload: JSON.stringify({ result, intent }),
                })
            )
        },
        async logSubmission(
            runId: string,
            strategyId: string,
            result: ExecutionResult,
            intent: OrderIntent
        ): Promise<void> {
            const action = intent.metadata?.action
            const eventType =
                action === "modify"
                    ? result.status === "rejected"
                        ? "rejected"
                        : "submission"
                    : result.status === "filled"
                    ? "filled"
                    : result.status === "cancelled"
                        ? "cancelled"
                        : result.status === "rejected"
                            ? "rejected"
                            : "submission"

            await runWithTimeout(
                "Convex mutation logTradeEvent(submission)",
                async () => await client.mutation(api.mutations.logTradeEvent, {
                    ...requireMachineAuth(),
                    runId: runId as Id<"strategy_runs">,
                    strategyId: strategyId as Id<"strategies">,
                    eventType,
                    payload: JSON.stringify({ result, intent }),
                })
            )
        },
        async logFillUpdate(runId: string, strategyId: string, result: ExecutionResult): Promise<void> {
            const eventType = result.status === "filled" ? "filled" : "fill_update"
            await runWithTimeout(
                "Convex mutation logTradeEvent(fillUpdate)",
                async () => await client.mutation(api.mutations.logTradeEvent, {
                    ...requireMachineAuth(),
                    runId: runId as Id<"strategy_runs">,
                    strategyId: strategyId as Id<"strategies">,
                    eventType,
                    payload: JSON.stringify(result),
                })
            )
        },
        async syncPositions(strategyId: Id<"strategies">, app: App, positions: Position[]): Promise<void> {
            await runWithTimeout(
                "Convex mutation syncPositions",
                async () => await client.mutation(api.mutations.syncPositions, {
                    ...requireMachineAuth(),
                    strategyId,
                    app: app as "alpaca-options" | "polymarket" | "mt5" | "okx-swap",
                    positions: positions.map((position) => ({
                        instrument: position.instrument,
                        side: position.side,
                        quantity: position.quantity,
                        entryPrice: position.entryPrice,
                        currentPrice: position.currentPrice,
                        unrealizedPnl: position.unrealizedPnl,
                        metadata: position.metadata ? JSON.stringify(position.metadata) : undefined,
                    })),
                })
            )
        },
        async reconcileProviderPortfolio(
            app: Exclude<App, "backend">,
            venue: string,
            source: ProviderPortfolioReconciliationResult["source"],
            accountState: AccountState,
            positions: Position[],
            workingOrders: WorkingOrder[]
        ): Promise<ProviderPortfolioReconciliationResult> {
            return await runWithTimeout(
                "Convex mutation reconcileProviderPortfolio",
                async () => await client.mutation(api.mutations.reconcileProviderPortfolio, {
                    ...requireMachineAuth(),
                    app,
                    venue,
                    source,
                    accountState: {
                        balance: accountState.balance,
                        equity: accountState.equity,
                        buyingPower: accountState.buyingPower,
                        marginUsed: accountState.marginUsed,
                        marginAvailable: accountState.marginAvailable,
                        openPnl: accountState.openPnl,
                        dayPnl: accountState.dayPnl,
                    },
                    positions: positions.map((position) => ({
                        instrument: position.instrument,
                        side: position.side,
                        quantity: position.quantity,
                        entryPrice: position.entryPrice,
                        currentPrice: position.currentPrice,
                        unrealizedPnl: position.unrealizedPnl,
                        stopLoss: position.stopLoss,
                        takeProfit: position.takeProfit,
                        metadata: position.metadata ? JSON.stringify(position.metadata) : undefined,
                    })),
                    workingOrders: workingOrders.map((order) => ({
                        orderId: order.orderId,
                        instrument: order.instrument,
                        status: order.status,
                        quantity: order.quantity,
                        filledQuantity: order.filledQuantity,
                        remainingQuantity: order.remainingQuantity,
                        submittedAt: order.submittedAt,
                        updatedAt: order.updatedAt,
                        side: order.side,
                        limitPrice: order.limitPrice,
                        stopPrice: order.stopPrice,
                        avgFillPrice: order.avgFillPrice,
                        metadata: order.metadata ? JSON.stringify(order.metadata) : undefined,
                    })),
                } as never) as ProviderPortfolioReconciliationResult
            )
        },
        async recordProviderSyncFailure(app: Exclude<App, "backend">, error: string): Promise<void> {
            await runWithTimeout(
                "Convex mutation recordProviderSyncFailure",
                async () => await client.mutation(api.mutations.recordProviderSyncFailure, {
                    ...requireMachineAuth(),
                    app,
                    error,
                } as never)
            )
        },
        async resolveSecrets(keys: string[]): Promise<Record<string, string | null>> {
            return await runWithTimeout(
                "Convex action resolveSecrets",
                async () => await client.action(api.actions.resolveSecrets, {
                    keys,
                    ...requireMachineAuth(),
                }) as Record<string, string | null>
            )
        },
        async reportHeartbeat(app: App, status: "healthy" | "degraded" | "unhealthy", metadata?: Record<string, unknown>): Promise<void> {
            await runWithTimeout(
                "Convex mutation reportHeartbeat",
                async () => await client.mutation(api.mutations.reportHeartbeat, {
                    ...requireMachineAuth(),
                    app,
                    status,
                    metadata,
                } as never)
            )
        },
        async reportHeartbeatLiveness(
            app: App,
            status: "healthy" | "degraded" | "unhealthy",
            metadata?: Record<string, unknown>
        ): Promise<void> {
            await runWithTimeout(
                "Convex mutation reportHeartbeatLiveness",
                async () => await client.mutation(api.mutations.reportHeartbeatLiveness, {
                    ...requireMachineAuth(),
                    app,
                    status,
                    metadata,
                } as never)
            )
        },
        async reportHeartbeatSnapshot(args: {
            app: App
            status: "healthy" | "degraded" | "unhealthy"
            metadata: Record<string, unknown>
            force?: boolean
        }): Promise<{
            written: boolean
            suppressed: boolean
            metadataHash: string
            lastSnapshotAt: number
            suppressedWrites: number
        }> {
            return await runWithTimeout(
                "Convex mutation reportHeartbeatSnapshot",
                async () => await client.mutation(api.mutations.reportHeartbeatSnapshot, {
                    ...requireMachineAuth(),
                    app: args.app,
                    status: args.status,
                    metadata: args.metadata,
                    force: args.force,
                } as never) as {
                    written: boolean
                    suppressed: boolean
                    metadataHash: string
                    lastSnapshotAt: number
                    suppressedWrites: number
                }
            )
        },
        async snapshotAccountState(app: App, venue: string, state: AccountState): Promise<void> {
            await runWithTimeout(
                "Convex mutation snapshotAccountState",
                async () => await client.mutation(api.mutations.snapshotAccountState, {
                    ...requireMachineAuth(),
                    app,
                    venue,
                    balance: state.balance,
                    equity: state.equity,
                    buyingPower: state.buyingPower,
                    marginUsed: state.marginUsed,
                    marginAvailable: state.marginAvailable,
                    openPnl: state.openPnl,
                    dayPnl: state.dayPnl,
                } as never)
            )
        },
        async getSystemState(): Promise<KillSwitchState> {
            return await runWithTimeout(
                "Convex query getSystemState",
                async () => await client.query(api.queries.getSystemState, { ...requireMachineAuth() }) as KillSwitchState
            )
        },
        async getControlPlaneMetrics(): Promise<ControlPlaneMetricRow[]> {
            return await runWithTimeout(
                "Convex query getControlPlaneMetrics",
                async () => await client.query(api.queries.getControlPlaneMetrics, { ...requireMachineAuth() } as never) as ControlPlaneMetricRow[]
            )
        },
        async getPortfolioFreshness(app?: Exclude<App, "backend">): Promise<PortfolioFreshnessRow[]> {
            return await runWithTimeout(
                "Convex query getPortfolioFreshness",
                async () => await client.query(api.queries.getPortfolioFreshness, {
                    ...requireMachineAuth(),
                    app,
                } as never) as PortfolioFreshnessRow[]
            )
        },
        async getPortfolioPositions(
            app?: Exclude<App, "backend">,
            strategyId?: Id<"strategies">
        ): Promise<ProviderPositionRow[]> {
            return await runWithTimeout(
                "Convex query getPortfolioPositions",
                async () => await client.query(api.queries.getPortfolioPositions, {
                    ...requireMachineAuth(),
                    app,
                    strategyId,
                } as never) as ProviderPositionRow[]
            )
        },
        async getPortfolioPendingOrders(
            app?: Exclude<App, "backend">,
            strategyId?: Id<"strategies">
        ): Promise<ProviderPendingOrderRow[]> {
            return await runWithTimeout(
                "Convex query getPortfolioPendingOrders",
                async () => await client.query(api.queries.getPortfolioPendingOrders, {
                    ...requireMachineAuth(),
                    app,
                    strategyId,
                } as never) as ProviderPendingOrderRow[]
            )
        },
        async adoptProviderPositions(
            app: Exclude<App, "backend">,
            strategyId: Id<"strategies">,
            instruments: string[]
        ): Promise<AdoptProviderPositionsResult> {
            return await runWithTimeout(
                "Convex mutation adoptProviderPositions",
                async () => await client.mutation(api.mutations.adoptProviderPositions, {
                    ...requireMachineAuth(),
                    app,
                    strategyId,
                    instruments,
                } as never) as AdoptProviderPositionsResult
            )
        },
        async getManualRunRequests(app: Exclude<App, "backend">): Promise<ManualRunRequest[]> {
            return await runWithTimeout(
                "Convex query getManualRunRequests",
                async () => await client.query(api.queries.getManualRunRequests, { ...requireMachineAuth(), app } as never) as ManualRunRequest[]
            )
        },
        async claimManualRunRequests(args: {
            app: Exclude<App, "backend">
            workerId: string
            leaseMs?: number
            maxClaims?: number
            maxAttempts?: number
        }): Promise<{
            app: Exclude<App, "backend">
            claimed: ClaimedManualRunRequest[]
            contentionCount: number
            terminalizedCount: number
            maxAttempts: number
            leaseMs: number
        }> {
            return await runWithTimeout(
                "Convex mutation claimManualRunRequests",
                async () => await client.mutation(api.mutations.claimManualRunRequests, {
                    ...requireMachineAuth(),
                    app: args.app,
                    workerId: args.workerId,
                    leaseMs: args.leaseMs,
                    maxClaims: args.maxClaims,
                    maxAttempts: args.maxAttempts,
                } as never) as {
                    app: Exclude<App, "backend">
                    claimed: ClaimedManualRunRequest[]
                    contentionCount: number
                    terminalizedCount: number
                    maxAttempts: number
                    leaseMs: number
                }
            )
        },
        async ackManualRunRequest(args: {
            requestId: Id<"manual_run_requests">
            workerId: string
            outcome: "completed" | "requeue" | "retryable_failure" | "terminal_failure"
            error?: string
            maxAttempts?: number
        }): Promise<{ status: "missing" | "already_terminal" | "completed" | "requeue" | "retryable_failure" | "terminal_failure" }> {
            return await runWithTimeout(
                "Convex mutation ackManualRunRequest",
                async () => await client.mutation(api.mutations.ackManualRunRequest, {
                    ...requireMachineAuth(),
                    requestId: args.requestId,
                    workerId: args.workerId,
                    outcome: args.outcome,
                    error: args.error,
                    maxAttempts: args.maxAttempts,
                } as never) as { status: "missing" | "already_terminal" | "completed" | "requeue" | "retryable_failure" | "terminal_failure" }
            )
        },
        async clearManualRunRequest(requestId: Id<"manual_run_requests">): Promise<void> {
            await runWithTimeout(
                "Convex mutation clearManualRunRequest",
                async () => await client.mutation(api.mutations.clearManualRunRequest, { ...requireMachineAuth(), requestId } as never)
            )
        },
        async createAlert(args: { strategyId?: string; app?: App; severity: "critical" | "warning" | "info"; message: string }): Promise<void> {
            await runWithTimeout(
                "Convex mutation createAlert",
                async () => await client.mutation(api.mutations.createAlert, {
                    ...requireMachineAuth(),
                    strategyId: args.strategyId as Id<"strategies"> | undefined,
                    app: args.app,
                    severity: args.severity,
                    message: args.message,
                } as never)
            )
        },
        async triggerManualRun(strategyId: Id<"strategies">): Promise<Id<"manual_run_requests">> {
            return await runWithTimeout(
                "Convex mutation triggerManualRun",
                async () => await client.mutation(api.mutations.triggerManualRun, { strategyId } as never) as Id<"manual_run_requests">
            )
        },
        async acknowledgeAlert(alertId: Id<"alerts">): Promise<void> {
            await runWithTimeout(
                "Convex mutation acknowledgeAlert",
                async () => await client.mutation(api.mutations.acknowledgeAlert, { alertId } as never)
            )
        },
        async getStrategyOwnedInstruments(strategyId: Id<"strategies">): Promise<string[]> {
            return await runWithTimeout(
                "Convex query getStrategyOwnedInstruments",
                async () => await client.query(api.queries.getStrategyOwnedInstruments, { ...requireMachineAuth(), strategyId } as never) as string[]
            )
        },
        async getAllOwnedInstrumentsByApp(app: Exclude<App, "backend">): Promise<Array<{ instrument: string, strategyId: string }>> {
            return await runWithTimeout(
                "Convex query getAllOwnedInstrumentsByApp",
                async () => await client.query(api.queries.getAllOwnedInstrumentsByApp, { ...requireMachineAuth(), app } as never) as Array<{ instrument: string, strategyId: string }>
            )
        },
        async getLatestPositions(strategyId: Id<"strategies">): Promise<Position[]> {
            const docs = await runWithTimeout(
                "Convex query getStrategyPositions",
                async () => await client.query(api.queries.getStrategyPositions, {
                    ...requireMachineAuth(),
                    strategyId,
                } as never) as Array<{
                    instrument: string
                    side: "long" | "short"
                    quantity: number
                    entryPrice: number
                    currentPrice?: number
                    unrealizedPnl?: number
                    metadata?: string
                }>
            )
            return docs.map((doc) => ({
                instrument: doc.instrument,
                side: doc.side,
                quantity: doc.quantity,
                entryPrice: doc.entryPrice,
                currentPrice: doc.currentPrice,
                unrealizedPnl: doc.unrealizedPnl,
                metadata: doc.metadata ? JSON.parse(doc.metadata) as Record<string, unknown> : undefined,
            }))
        },
        async getAllStrategies(): Promise<StoredStrategy[]> {
            return await runWithTimeout(
                "Convex query getAllStrategies",
                async () => await client.query(api.queries.getAllStrategies, { ...requireMachineAuth() }) as StoredStrategy[]
            )
        },
        async addStrategy(config: StrategyConfig): Promise<Id<"strategies">> {
            return await runWithTimeout(
                "Convex mutation upsertStrategy",
                async () => await client.mutation(api.mutations.upsertStrategy, {
                    ...requireMachineAuth(),
                    app: config.app,
                    name: config.name,
                    enabled: config.enabled,
                    schedule: config.schedule,
                    policy: config.policy,
                    context: config.context,
                } as never) as Id<"strategies">
            )
        },
        async disableStrategy(id: Id<"strategies">): Promise<void> {
            await runWithTimeout(
                "Convex mutation disableStrategy",
                async () => await client.mutation(api.mutations.disableStrategy, {
                    ...requireMachineAuth(),
                    strategyId: id,
                } as never)
            )
        },
        async deleteStrategy(id: Id<"strategies">): Promise<DeleteStrategyResult> {
            return await runWithTimeout(
                "Convex mutation deleteStrategy",
                async () => await client.mutation(api.mutations.deleteStrategy, {
                    ...requireMachineAuth(),
                    strategyId: id,
                } as never) as DeleteStrategyResult
            )
        },
        async deleteStrategyBatch(
            id: Id<"strategies">,
            batchSize?: number
        ): Promise<DeleteStrategyBatchResult> {
            return await runWithTimeout(
                "Convex mutation deleteStrategyBatch",
                async () => await client.mutation(api.mutations.deleteStrategyBatch, {
                    ...requireMachineAuth(),
                    strategyId: id,
                    batchSize,
                } as never) as DeleteStrategyBatchResult
            )
        },
        async deleteAllStrategies(): Promise<DeleteAllStrategiesResult> {
            return await runWithTimeout(
                "Convex mutation deleteAllStrategies",
                async () => await client.mutation(api.mutations.deleteAllStrategies, {
                    ...requireMachineAuth(),
                } as never) as DeleteAllStrategiesResult
            )
        },
        async deleteOrphanedStrategyHistoryBatch(
            batchSize?: number
        ): Promise<DeleteOrphanedStrategyHistoryBatchResult> {
            return await runWithTimeout(
                "Convex mutation deleteOrphanedStrategyHistoryBatch",
                async () => await client.mutation(api.mutations.deleteOrphanedStrategyHistoryBatch, {
                    ...requireMachineAuth(),
                    batchSize,
                } as never) as DeleteOrphanedStrategyHistoryBatchResult
            )
        },
        async clearFullResetState(): Promise<CascadeDeleteCounts> {
            return await runWithTimeout(
                "Convex mutation clearFullResetState",
                async () => await client.mutation(api.mutations.clearFullResetState, {
                    ...requireMachineAuth(),
                } as never) as CascadeDeleteCounts
            )
        },
        async clearFullResetStateBatch(
            batchSize?: number,
            preserveApps?: App[]
        ): Promise<ClearFullResetStateBatchResult> {
            return await runWithTimeout(
                "Convex mutation clearFullResetStateBatch",
                async () => await client.mutation(api.mutations.clearFullResetStateBatch, {
                    ...requireMachineAuth(),
                    batchSize,
                    preserveApps,
                } as never) as ClearFullResetStateBatchResult
            )
        },
        async getFullResetAudit(): Promise<FullResetAudit> {
            return await runWithTimeout(
                "Convex query getFullResetAudit",
                async () => await client.query(api.queries.getFullResetAudit, {
                    ...requireMachineAuth(),
                } as never) as FullResetAudit
            )
        },
        async replaceAllStrategies(strategies: StrategyConfig[]): Promise<ReplaceAllStrategiesResult> {
            return await runWithTimeout(
                "Convex mutation replaceAllStrategies",
                async () => await client.mutation(api.mutations.replaceAllStrategies, {
                    ...requireMachineAuth(),
                    strategies,
                } as never) as ReplaceAllStrategiesResult
            )
        },
    }
}

export const createConvexOrderPersistenceAdapter = (
    config: ConvexOrderPersistenceConfig
): OrderPersistenceAdapter => {
    const client = new ConvexHttpClient(config.url)
    const timeoutMs = config.timeoutMs ?? 30_000

    const requireAdapterAuth = (): { serviceToken: string } => {
        const serviceToken = config.machineAuth?.serviceToken?.trim()

        if (!serviceToken) {
            throw new Error("Order persistence adapter requires a backend service token")
        }

        return { serviceToken }
    }

    const runWithTimeout = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
        return await withTimeout(operation, timeoutMs, name)
    }

    return {
        async upsertOrder(snapshot: OrderSnapshot): Promise<void> {
            await runWithTimeout(
                "Convex mutation upsertOrder",
                async () => await client.mutation(api.mutations.upsertOrder, {
                    ...requireAdapterAuth(),
                    orderId: snapshot.orderId,
                    runId: snapshot.runId as Id<"strategy_runs">,
                    strategyId: snapshot.strategyId as Id<"strategies">,
                    venue: snapshot.venue,
                    instrument: snapshot.instrument,
                    status: snapshot.status,
                    action: snapshot.action,
                    quantity: snapshot.quantity,
                    filledQuantity: snapshot.filledQuantity,
                    remainingQuantity: snapshot.remainingQuantity,
                    avgFillPrice: snapshot.avgFillPrice,
                    submittedAt: snapshot.submittedAt,
                    updatedAt: snapshot.updatedAt,
                    intent: snapshot.intent,
                    metadata: snapshot.metadata,
                    polling: snapshot.polling,
                })
            )
        },
        async logOrderTransition(transition: OrderTransition): Promise<void> {
            await runWithTimeout(
                "Convex mutation logOrderTransition",
                async () => await client.mutation(api.mutations.logOrderTransition, {
                    ...requireAdapterAuth(),
                    orderId: transition.orderId,
                    runId: transition.runId as Id<"strategy_runs">,
                    strategyId: transition.strategyId as Id<"strategies">,
                    sequence: transition.sequence,
                    type: transition.type,
                    status: transition.status,
                    previousStatus: transition.previousStatus,
                    reason: transition.reason,
                    details: transition.details,
                    timestamp: transition.timestamp,
                })
            )
        },
        async getOrder(orderId: string): Promise<OrderSnapshot | null> {
            const order = await runWithTimeout(
                "Convex query getOrderById",
                async () => await client.query(api.queries.getOrderById, { ...requireAdapterAuth(), orderId })
            )
            return order as OrderSnapshot | null
        },
        async listActiveOrders(strategyId: string): Promise<OrderSnapshot[]> {
            const orders = await runWithTimeout(
                "Convex query getActiveOrders",
                async () => await client.query(api.queries.getActiveOrders, {
                    ...requireAdapterAuth(),
                    strategyId: strategyId as Id<"strategies">,
                })
            )
            return orders as OrderSnapshot[]
        },
        async createAlert(alert: OrderLifecycleAlert): Promise<void> {
            await runWithTimeout(
                "Convex mutation createAlert(orderLifecycle)",
                async () => await client.mutation(api.mutations.createAlert, {
                    ...requireAdapterAuth(),
                    strategyId: alert.strategyId as Id<"strategies">,
                    severity: alert.severity,
                    message: alert.message,
                })
            )
        },
    }
}

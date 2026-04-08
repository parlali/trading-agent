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
    app: App
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
    manualRunRequests: number
    alerts: number
}

export interface DeleteStrategyResult extends CascadeDeleteCounts {}

export interface DeleteAllStrategiesResult extends CascadeDeleteCounts {
    strategies: number
}

export interface ReplaceAllStrategiesResult {
    importedStrategies: number
    deleted: DeleteAllStrategiesResult
}

export interface ProviderPortfolioReconciliationResult {
    app: Exclude<App, "backend">
    source: "startup_sync" | "periodic_sync" | "post_run_sync"
    positionCount: number
    pendingOrderCount: number
    driftDetected: boolean
    driftSummary?: string
}

export interface TradingBackendClient extends TradeEventLoggerMethods {
    getStrategyConfigs(app: App): Promise<StoredStrategy[]>
    getStrategyById(id: Id<"strategies">): Promise<StoredStrategy | null>
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
    reportHeartbeat(app: App, status: "healthy" | "degraded" | "unhealthy", metadata?: Record<string, unknown>): Promise<void>
    snapshotAccountState(app: App, venue: string, state: AccountState): Promise<void>
    getSystemState(): Promise<KillSwitchState>
    getManualRunRequests(app: Exclude<App, "backend">): Promise<ManualRunRequest[]>
    clearManualRunRequest(requestId: Id<"manual_run_requests">): Promise<void>
    createAlert(args: { strategyId?: string; app?: App; severity: "critical" | "warning" | "info"; message: string }): Promise<void>
    triggerManualRun(strategyId: Id<"strategies">): Promise<Id<"manual_run_requests">>
    acknowledgeAlert(alertId: Id<"alerts">): Promise<void>
    getStrategyOwnedInstruments(strategyId: Id<"strategies">): Promise<string[]>
    getAllOwnedInstrumentsByApp(app: Exclude<App, "backend">): Promise<Array<{ instrument: string, strategyId: string }>>
    getLatestPositions(strategyId: Id<"strategies">): Promise<Position[]>
    getAllStrategies(): Promise<StoredStrategy[]>
    addStrategy(config: StrategyConfig): Promise<Id<"strategies">>
    deleteStrategy(id: Id<"strategies">): Promise<DeleteStrategyResult>
    deleteAllStrategies(): Promise<DeleteAllStrategiesResult>
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
            const eventType =
                result.status === "filled"
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
                    app: app as "alpaca-options" | "polymarket" | "mt5" | "binance-futures",
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
        async getManualRunRequests(app: Exclude<App, "backend">): Promise<ManualRunRequest[]> {
            return await runWithTimeout(
                "Convex query getManualRunRequests",
                async () => await client.query(api.queries.getManualRunRequests, { ...requireMachineAuth(), app } as never) as ManualRunRequest[]
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
        async deleteStrategy(id: Id<"strategies">): Promise<DeleteStrategyResult> {
            return await runWithTimeout(
                "Convex mutation deleteStrategy",
                async () => await client.mutation(api.mutations.deleteStrategy, {
                    ...requireMachineAuth(),
                    strategyId: id,
                } as never) as DeleteStrategyResult
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

import { api } from "../convex/_generated/api"
import type { Id } from "../convex/_generated/dataModel"
import type {
    AccountState,
    App,
    ExecutionResult,
    OrderIntent,
    Position,
    ProviderPositionClosure,
    StrategyConfig,
    ValidationResult,
    WorkingOrder,
} from "@valiq-trading/core"
import { mapStrategyRiskStateRow } from "./client-types"
import { createMachineConvexHttpContext } from "./convex-http"
import type {
    AdoptProviderPositionsResult,
    AckManualRunRequestArgs,
    AckManualRunRequestResult,
    CascadeDeleteCounts,
    ClearFullResetStateBatchResult,
    ClaimManualRunRequestsArgs,
    ClaimManualRunRequestsResult,
    ControlPlaneMetricRow,
    CreateAlertArgs,
    DeleteAllStrategiesResult,
    DeleteOrphanedStrategyHistoryBatchResult,
    DeleteStrategyBatchResult,
    DeleteStrategyResult,
    AgentLogRow,
    ExecutionSafetyFaultRow,
    FullResetAudit,
    KillSwitchState,
    LastCompletedRunSummary,
    ManualRunRequest,
    PortfolioFreshnessRow,
    ProviderPendingOrderRow,
    ProviderPortfolioReconciliationResult,
    ProviderPositionRow,
    RawStrategyRiskStateRow,
    RecordExecutionSafetyFaultArgs,
    ReplaceAllStrategiesResult,
    RefreshStrategyRiskStateArgs,
    ReportHeartbeatSnapshotArgs,
    ReportHeartbeatSnapshotResult,
    ResolveExecutionSafetyFaultsArgs,
    RunDiagnostics,
    RunTrigger,
    StoredRun,
    StoredStrategy,
    StrategyOrderHistoryRow,
    StrategyOwnershipScopeRow,
    StrategyRiskStateRow,
    TradeEventRow,
    TradingBackendClient,
    TradingBackendClientConfig,
} from "./client-types"

function toProviderPositionInput(position: Position) {
    return {
        instrument: position.instrument,
        providerPositionId: position.providerPositionId,
        side: position.side,
        quantity: position.quantity,
        entryPrice: position.entryPrice,
        currentPrice: position.currentPrice,
        unrealizedPnl: position.unrealizedPnl,
        stopLoss: position.stopLoss,
        takeProfit: position.takeProfit,
        metadata: position.metadata ? JSON.stringify(position.metadata) : undefined,
    }
}

type PositionDocRow = {
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

function mapPositionRows(rows: PositionDocRow[]): Position[] {
    return rows.map((row) => ({
        instrument: row.instrument,
        providerPositionId: row.providerPositionId,
        side: row.side,
        quantity: row.quantity,
        entryPrice: row.entryPrice,
        currentPrice: row.currentPrice,
        unrealizedPnl: row.unrealizedPnl,
        stopLoss: row.stopLoss,
        takeProfit: row.takeProfit,
        metadata: parsePositionMetadata(row.metadata),
    }))
}

function parsePositionMetadata(metadata?: string): Record<string, unknown> | undefined {
    if (!metadata) {
        return undefined
    }

    try {
        const parsed = JSON.parse(metadata)
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : undefined
    } catch {
        return undefined
    }
}

export const createTradingBackendClient = (config: string | TradingBackendClientConfig): TradingBackendClient => {
    const resolvedConfig =
        typeof config === "string"
            ? { url: config }
            : config
    const { client, requireMachineAuth, runWithTimeout } = createMachineConvexHttpContext(
        resolvedConfig,
        "Machine-authenticated Convex call requires a backend service token"
    )

    const logTradeEvent = async (
        name: string,
        runId: string,
        strategyId: string,
        eventType: "intent" | "validation" | "submission" | "fill_update" | "filled" | "rejected" | "cancelled",
        payload: unknown
    ): Promise<void> => {
        await runWithTimeout(
            name,
            async () => await client.mutation(api.mutations.logTradeEvent, {
                ...requireMachineAuth(),
                runId: runId as Id<"strategy_runs">,
                strategyId: strategyId as Id<"strategies">,
                eventType,
                payload: JSON.stringify(payload),
            })
        )
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
        async getRunHistory(strategyId: Id<"strategies">, limit?: number, beforeStartedAt?: number): Promise<StoredRun[]> {
            return await runWithTimeout(
                "Convex query getRunHistory",
                async () => await client.query(api.queries.getRunHistory, {
                    ...requireMachineAuth(),
                    strategyId,
                    limit,
                    beforeStartedAt,
                } as never) as StoredRun[]
            )
        },
        async getRunById(runId: Id<"strategy_runs">): Promise<StoredRun | null> {
            return await runWithTimeout(
                "Convex query getRunById",
                async () => await client.query(api.queries.getRunById, {
                    ...requireMachineAuth(),
                    runId,
                } as never) as StoredRun | null
            )
        },
        async getAgentLogs(runId: Id<"strategy_runs">): Promise<AgentLogRow[]> {
            return await runWithTimeout(
                "Convex query getAgentLogs",
                async () => await client.query(api.queries.getAgentLogs, {
                    ...requireMachineAuth(),
                    runId,
                } as never) as AgentLogRow[]
            )
        },
        async getTradeEvents(runId: Id<"strategy_runs">): Promise<TradeEventRow[]> {
            return await runWithTimeout(
                "Convex query getTradeEvents",
                async () => await client.query(api.queries.getTradeEvents, {
                    ...requireMachineAuth(),
                    runId,
                } as never) as TradeEventRow[]
            )
        },
        async getLastCompletedRunSummary(strategyId: Id<"strategies">): Promise<LastCompletedRunSummary | null> {
            return await runWithTimeout(
                "Convex query getLastCompletedRunSummary",
                async () => await client.query(api.queries.getLastCompletedRunSummary, { ...requireMachineAuth(), strategyId } as never) as LastCompletedRunSummary | null
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
            error?: string,
            diagnostics?: RunDiagnostics
        ): Promise<void> {
            await runWithTimeout(
                "Convex mutation updateRun",
                async () => await client.mutation(api.mutations.updateRun, {
                    ...requireMachineAuth(),
                    runId,
                    status,
                    summary,
                    error,
                    diagnostics,
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
            toolOutput?: string,
            toolCalls?: string
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
                    toolCalls,
                })
            )
        },
        async logIntent(runId: string, strategyId: string, intent: OrderIntent): Promise<void> {
            await logTradeEvent("Convex mutation logTradeEvent(intent)", runId, strategyId, "intent", intent)
        },
        async logValidation(
            runId: string,
            strategyId: string,
            result: ValidationResult,
            intent: OrderIntent
        ): Promise<void> {
            await logTradeEvent(
                "Convex mutation logTradeEvent(validation)",
                runId,
                strategyId,
                result.allowed ? "validation" : "rejected",
                { result, intent }
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

            await logTradeEvent(
                "Convex mutation logTradeEvent(submission)",
                runId,
                strategyId,
                eventType,
                { result, intent }
            )
        },
        async logFillUpdate(runId: string, strategyId: string, result: ExecutionResult): Promise<void> {
            const eventType = result.status === "filled" ? "filled" : "fill_update"
            await logTradeEvent("Convex mutation logTradeEvent(fillUpdate)", runId, strategyId, eventType, result)
        },
        async syncPositions(strategyId: Id<"strategies">, app: App, positions: Position[]): Promise<void> {
            await runWithTimeout(
                "Convex mutation syncPositions",
                async () => await client.mutation(api.mutations.syncPositions, {
                    ...requireMachineAuth(),
                    strategyId,
                    app: app as "alpaca-options" | "polymarket" | "mt5" | "okx-swap",
                    positions: positions.map(toProviderPositionInput),
                })
            )
        },
        async reconcileProviderPortfolio(
            app: Exclude<App, "backend">,
            venue: string,
            source: ProviderPortfolioReconciliationResult["source"],
            accountState: AccountState,
            positions: Position[],
            workingOrders: WorkingOrder[],
            positionClosures: ProviderPositionClosure[] = []
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
                    positions: positions.map(toProviderPositionInput),
                    workingOrders: workingOrders.map((order) => ({
                        orderId: order.orderId,
                        canonicalOrderId: order.canonicalOrderId,
                        providerOrderId: order.providerOrderId,
                        providerClientOrderId: order.providerClientOrderId,
                        providerOrderAliases: order.providerOrderAliases,
                        signedOrderFingerprint: order.signedOrderFingerprint,
                        instrument: order.instrument,
                        status: order.status,
                        quantity: order.quantity,
                        filledQuantity: order.filledQuantity,
                        remainingQuantity: order.remainingQuantity,
                        submittedAt: order.submittedAt,
                        updatedAt: order.updatedAt,
                        cancelAt: order.cancelAt,
                        side: order.side,
                        limitPrice: order.limitPrice,
                        stopPrice: order.stopPrice,
                        avgFillPrice: order.avgFillPrice,
                        metadata: order.metadata ? JSON.stringify(order.metadata) : undefined,
                    })),
                    positionClosures: positionClosures.map((closure) => ({
                        instrument: closure.instrument,
                        providerPositionId: closure.providerPositionId,
                        side: closure.side,
                        quantity: closure.quantity,
                        fillPrice: closure.fillPrice,
                        closedAt: closure.closedAt,
                        metadata: closure.metadata ? JSON.stringify(closure.metadata) : undefined,
                    })),
                } as never) as ProviderPortfolioReconciliationResult
            )
        },
        async refreshStrategyRiskState(args: RefreshStrategyRiskStateArgs): Promise<StrategyRiskStateRow> {
            const result = await runWithTimeout(
                "Convex mutation refreshStrategyRiskState",
                async () => await client.mutation(api.mutations.refreshStrategyRiskState, {
                    ...requireMachineAuth(),
                    strategyId: args.strategyId,
                    app: args.app,
                    policy: args.policy,
                } as never) as RawStrategyRiskStateRow | StrategyRiskStateRow
            )
            const mapped = mapStrategyRiskStateRow(result)
            if (!mapped) {
                throw new Error("refreshStrategyRiskState returned empty payload")
            }
            return mapped
        },
        async recordExecutionSafetyFault(args: RecordExecutionSafetyFaultArgs): Promise<string> {
            return await runWithTimeout(
                "Convex mutation recordExecutionSafetyFault",
                async () => await client.mutation(api.mutations.recordExecutionSafetyFault, {
                    ...requireMachineAuth(),
                    strategyId: args.strategyId,
                    app: args.app,
                    instrument: args.instrument,
                    category: args.category,
                    message: args.message,
                    providerPayload: args.providerPayload,
                    canonicalOrderId: args.canonicalOrderId,
                    providerOrderId: args.providerOrderId,
                    providerClientOrderId: args.providerClientOrderId,
                    providerOrderAliases: args.providerOrderAliases,
                    submitAttemptId: args.submitAttemptId,
                    submitAttemptSequence: args.submitAttemptSequence,
                    runId: args.runId,
                    venue: args.venue,
                    signedOrderFingerprint: args.signedOrderFingerprint,
                    recoveryProbeEvidence: args.recoveryProbeEvidence,
                    blocked: args.blocked,
                } as never) as string
            )
        },
        async resolveExecutionSafetyFaults(args: ResolveExecutionSafetyFaultsArgs): Promise<{ resolved: number }> {
            return await runWithTimeout(
                "Convex mutation resolveExecutionSafetyFaults",
                async () => await client.mutation(api.mutations.resolveExecutionSafetyFaults, {
                    ...requireMachineAuth(),
                    strategyId: args.strategyId,
                    instrument: args.instrument,
                    resolutionNote: args.resolutionNote,
                } as never) as { resolved: number }
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
        async reportHeartbeatSnapshot(args: ReportHeartbeatSnapshotArgs): Promise<ReportHeartbeatSnapshotResult> {
            return await runWithTimeout(
                "Convex mutation reportHeartbeatSnapshot",
                async () => await client.mutation(api.mutations.reportHeartbeatSnapshot, {
                    ...requireMachineAuth(),
                    app: args.app,
                    status: args.status,
                    metadata: args.metadata,
                    force: args.force,
                } as never) as ReportHeartbeatSnapshotResult
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
        async getStrategyRiskState(strategyId: Id<"strategies">): Promise<StrategyRiskStateRow | null> {
            const row = await runWithTimeout(
                "Convex query getStrategyRiskState",
                async () => await client.query(api.queries.getStrategyRiskState, {
                    ...requireMachineAuth(),
                    strategyId,
                } as never) as RawStrategyRiskStateRow | StrategyRiskStateRow | null
            )
            return mapStrategyRiskStateRow(row)
        },
        async getStrategyExecutionSafetyFaults(
            strategyId: Id<"strategies">,
            unresolvedOnly?: boolean
        ): Promise<ExecutionSafetyFaultRow[]> {
            return await runWithTimeout(
                "Convex query getStrategyExecutionSafetyFaults",
                async () => await client.query(api.queries.getStrategyExecutionSafetyFaults, {
                    ...requireMachineAuth(),
                    strategyId,
                    unresolvedOnly,
                } as never) as ExecutionSafetyFaultRow[]
            )
        },
        async getStrategyOrderHistory(
            strategyId: Id<"strategies">,
            limit?: number
        ): Promise<StrategyOrderHistoryRow[]> {
            return await runWithTimeout(
                "Convex query getStrategyOrderHistory",
                async () => await client.query(api.queries.getStrategyOrderHistory, {
                    ...requireMachineAuth(),
                    strategyId,
                    limit,
                } as never) as StrategyOrderHistoryRow[]
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
        async claimManualRunRequests(args: ClaimManualRunRequestsArgs): Promise<ClaimManualRunRequestsResult> {
            return await runWithTimeout(
                "Convex mutation claimManualRunRequests",
                async () => await client.mutation(api.mutations.claimManualRunRequests, {
                    ...requireMachineAuth(),
                    app: args.app,
                    workerId: args.workerId,
                    leaseMs: args.leaseMs,
                    maxClaims: args.maxClaims,
                    maxAttempts: args.maxAttempts,
                } as never) as ClaimManualRunRequestsResult
            )
        },
        async ackManualRunRequest(args: AckManualRunRequestArgs): Promise<AckManualRunRequestResult> {
            return await runWithTimeout(
                "Convex mutation ackManualRunRequest",
                async () => await client.mutation(api.mutations.ackManualRunRequest, {
                    ...requireMachineAuth(),
                    requestId: args.requestId,
                    workerId: args.workerId,
                    outcome: args.outcome,
                    error: args.error,
                    maxAttempts: args.maxAttempts,
                } as never) as AckManualRunRequestResult
            )
        },
        async clearManualRunRequest(requestId: Id<"manual_run_requests">): Promise<void> {
            await runWithTimeout(
                "Convex mutation clearManualRunRequest",
                async () => await client.mutation(api.mutations.clearManualRunRequest, { ...requireMachineAuth(), requestId } as never)
            )
        },
        async createAlert(args: CreateAlertArgs): Promise<void> {
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
        async getInstrumentClaimsForStrategy(strategyId: Id<"strategies">): Promise<Array<{ instrument: string }>> {
            return await runWithTimeout(
                "Convex query getInstrumentClaimsForStrategy",
                async () => await client.query(api.queries.getInstrumentClaimsForStrategy, { ...requireMachineAuth(), strategyId } as never) as Array<{ instrument: string }>
            )
        },
        async getStrategyOwnershipScope(strategyId: Id<"strategies">): Promise<StrategyOwnershipScopeRow> {
            return await runWithTimeout(
                "Convex query getStrategyOwnershipScope",
                async () => await client.query(api.queries.getStrategyOwnershipScope, { ...requireMachineAuth(), strategyId } as never) as StrategyOwnershipScopeRow
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
                } as never) as PositionDocRow[]
            )
            return mapPositionRows(docs)
        },
        async getPositionsForRun(strategyId: Id<"strategies">, runId: Id<"strategy_runs">): Promise<Position[]> {
            const docs = await runWithTimeout(
                "Convex query getStrategyPositionsForRun",
                async () => await client.query(api.queries.getStrategyPositionsForRun, {
                    ...requireMachineAuth(),
                    strategyId,
                    runId,
                } as never) as PositionDocRow[]
            )
            return mapPositionRows(docs)
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
        async updateStrategy(id: Id<"strategies">, config: StrategyConfig): Promise<Id<"strategies">> {
            return await runWithTimeout(
                "Convex mutation upsertStrategy(update)",
                async () => await client.mutation(api.mutations.upsertStrategy, {
                    ...requireMachineAuth(),
                    id,
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

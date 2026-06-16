import type { Id } from "../convex/_generated/dataModel"
import type { CascadeDeleteCounts } from "../convex/lib/cascadeDelete"
import type {
    McpToolApproval,
    McpToolDiagnostic,
    McpToolDiscoveryRequest,
    McpToolInventoryEntry,
} from "@valiq-trading/agent"
import type {
    App,
    AppKillSwitches,
    OrderIntent,
    OrderSnapshot,
    PortfolioFreshness,
    PortfolioPendingOrder,
    PortfolioPosition,
    AccountPnlEvent,
    ProviderPositionClosure,
    RunSystemContextDigest,
    StrategyRiskState,
    StrategyConfig,
    TradeEventLogger,
    AccountState,
    AccountConfig,
    AgentMessageLogger,
    Position,
    WorkingOrder,
    ExecutionResult,
    ExecutionSafetyFaultCategory,
    ValidationResult,
} from "@valiq-trading/core"

export interface ToolManifestEntry {
    name: string
    category?: string
    contractBoundary?: string
    contractOwner?: string
}

export type {
    McpToolApproval,
    McpToolDiagnostic,
    McpToolDiscoveryRequest,
    McpToolInventoryEntry,
}

export interface ConvexOrderPersistenceConfig {
    url: string
    machineAuth?: {
        serviceToken: string
    }
    timeoutMs?: number
    orderLookupScope?: {
        app?: Exclude<App, "backend">
        accountId?: string
        strategyId?: string
    }
}

export interface TradingBackendClientConfig {
    url: string
    machineAuth?: {
        serviceToken: string
    }
    timeoutMs?: number
}

export interface CodexChatGptAuthRecord {
    authJson: string
    accountId: string
    lastRefresh?: string
    updatedAt: number
}

export interface StoreCodexChatGptAuthArgs {
    authJson: string
    accountId: string
    lastRefresh?: string | null
}

export interface StoredStrategy {
    _id: Id<"strategies">
    _creationTime: number
    app: Exclude<App, "backend">
    accountId: string
    name: string
    enabled: boolean
    schedule: string
    policy: Record<string, unknown>
    context: string
    createdAt?: number
    updatedAt?: number
}

export interface StoredAccount {
    _id: Id<"accounts">
    _creationTime: number
    app: Exclude<App, "backend">
    accountId: string
    label: string
    credentialEnvPrefix: string
    status: "active" | "disabled"
    notes?: string
    createdAt?: number
    updatedAt?: number
}

export interface StrategyMcpToolWhitelist {
    _id: Id<"strategy_mcp_tool_whitelists">
    _creationTime: number
    strategyId: Id<"strategies">
    tools: McpToolApproval[]
    discoveryTools?: McpToolDiscoveryRequest[]
    createdAt: number
    updatedAt: number
}

export interface McpToolInventoryResult {
    providers: Array<{
        id: string
        toolCount: number
        skippedCount: number
        status: "available" | "unavailable"
        error?: string
    }>
    tools: McpToolInventoryEntry[]
    diagnostics: McpToolDiagnostic[]
}

export type RunTrigger = "cron" | "manual" | "callback" | "chat"

export interface CreateRunMetadata {
    chatSource?: "dashboard"
    chatSessionId?: string
    chatMessageId?: string
}

export interface RunDiagnostics {
    degradedResearch?: boolean
    degradedReason?: string
    toolFailureCount?: number
    toolRetryCount?: number
    decisionUnderDegradedContext?: boolean
    promptTokens?: number
    completionTokens?: number
    reasoningTokens?: number
    llmCost?: number
    llmProvider?: "openrouter" | "codex"
    llmModel?: string
    llmAuthMode?: string
    llmBillingMode?: string
    llmResponseIds?: string[]
    codexThreadId?: string
    codexTurnIds?: string[]
    llmRateLimitSnapshotBefore?: unknown
    llmRateLimitSnapshotAfter?: unknown
    openRouterResponseIds?: string[]
    opportunityResearched?: number
    opportunityQualified?: number
    opportunityRejectedByModel?: number
    opportunityRejectedByRisk?: number
    opportunitySubmitted?: number
    opportunityFilled?: number
    opportunityClosed?: number
    opportunityRealizedPnl?: number
    toolCallCount?: number
    systemContextDigest?: RunSystemContextDigest
    mcpToolDiagnostics?: McpToolDiagnostic[]
    toolManifest?: ToolManifestEntry[]
}

export interface StoredRun extends RunDiagnostics {
    _id: Id<"strategy_runs">
    _creationTime: number
    strategyId: Id<"strategies">
    app: App
    status: "running" | "completed" | "failed"
    trigger?: RunTrigger
    chatSource?: "dashboard"
    chatSessionId?: string
    chatMessageId?: string
    startedAt: number
    endedAt?: number
    summary?: string
    error?: string
    callbackRequestedMinutes?: number
    callbackFiresAt?: number
}

export interface AgentLogRow {
    _id: Id<"agent_logs">
    _creationTime: number
    runId: Id<"strategy_runs">
    strategyId: Id<"strategies">
    sequence: number
    role: "system" | "user" | "assistant" | "tool"
    content: string
    toolName?: string
    toolInput?: string
    toolOutput?: string
    toolCalls?: string
    timestamp: number
}

export type AgentChatMode = "general" | "portfolio" | "operations" | "mcp"

export interface AgentChatMessageRow {
    id: string
    sessionId: string
    messageId: string
    role: "user" | "assistant"
    content: string
    mode?: AgentChatMode
    status: "received" | "running" | "completed" | "cancelled" | "failed"
    modelProvider?: string
    modelId?: string
    finishReason?: string
    reasoning?: string
    error?: string
    toolEvents?: AgentChatToolEventRow[]
    createdAt: number
    updatedAt: number
}

export interface AgentChatToolEventRow {
    toolCallId: string
    toolName: string
    state: "input" | "result" | "error"
    input?: unknown
    output?: unknown
    error?: string
    durationMs?: number
    createdAt: number
}

export interface RecordAgentChatUserMessageArgs {
    sessionId: string
    messageId: string
    content: string
    mode?: AgentChatMode
}

export interface RecordAgentChatAssistantMessageArgs {
    sessionId: string
    messageId: string
    content: string
    status: "running" | "completed" | "cancelled" | "failed"
    modelProvider: string
    modelId: string
    finishReason?: string
    reasoning?: string
    error?: string
}

export interface RecordAgentChatToolEventArgs {
    sessionId: string
    messageId: string
    toolCallId: string
    toolName: string
    state: "input" | "result" | "error"
    input?: unknown
    output?: unknown
    error?: string
    durationMs?: number
}

export interface TradeEventRow {
    _id: Id<"trade_events">
    _creationTime: number
    runId: Id<"strategy_runs">
    strategyId: Id<"strategies">
    app?: App
    eventType: "intent" | "validation" | "submission" | "fill_update" | "filled" | "rejected" | "cancelled"
    payload: string
    timestamp: number
}

export interface KillSwitchState {
    globalKillSwitch: boolean
    appKillSwitches: AppKillSwitches
    updatedAt: number
}

export { toVenueKillSwitchKey as toKillSwitchKey } from "@valiq-trading/core"

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

export type { CascadeDeleteCounts } from "../convex/lib/cascadeDelete"

export type DeleteStrategyResult = CascadeDeleteCounts

export type DeleteStrategyBatchResult = CascadeDeleteCounts & {
    strategyDeleted: boolean
    hasMore: boolean
}

export type DeleteAllStrategiesResult = CascadeDeleteCounts & {
    strategies: number
}

export type FullResetAudit = DeleteAllStrategiesResult

export interface ControlPlaneMetricRow {
    _id: Id<"control_plane_metrics">
    _creationTime: number
    metric: string
    app?: App
    value: number
    updatedAt: number
}

export type DeleteOrphanedStrategyHistoryBatchResult = CascadeDeleteCounts & {
    hasMore: boolean
}

export type ClearFullResetStateBatchResult = CascadeDeleteCounts & {
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
    accountId: string
    source: "startup_sync" | "periodic_sync" | "post_run_sync"
    positionCount: number
    pendingOrderCount: number
    driftDetected: boolean
    driftSummary?: string
}

export interface StrategyOwnershipScopeRow {
    instruments: string[]
    positionKeys: string[]
    workingOrderIds: string[]
}

export type PortfolioFreshnessRow = PortfolioFreshness

export interface PortfolioAccountSnapshotRow extends AccountState {
    app: Exclude<App, "backend">
    accountId: string
    venue: string
    timestamp: number
}

export type ProviderPositionRow = PortfolioPosition

export type ProviderPendingOrderRow = PortfolioPendingOrder

export interface AlertRow {
    id: string
    strategyId?: string
    app?: App
    severity: "critical" | "warning" | "info"
    message: string
    acknowledged: boolean
    timestamp: number
}

export interface GetRecentAlertsArgs {
    severity?: AlertRow["severity"]
    acknowledged?: boolean
    limit?: number
}

export interface StrategyRiskStateRow extends StrategyRiskState {
    strategyId: string
    app: Exclude<App, "backend">
}

export interface ExecutionSafetyFaultRow {
    _id: Id<"execution_safety_faults">
    _creationTime: number
    strategyId: Id<"strategies">
    app: Exclude<App, "backend">
    instrument: string
    category: ExecutionSafetyFaultCategory
    message: string
    providerPayload?: string
    canonicalOrderId?: string
    providerOrderId?: string
    providerClientOrderId?: string
    providerOrderAliases?: string[]
    submitAttemptId?: string
    submitAttemptSequence?: number
    runId?: Id<"strategy_runs">
    venue?: string
    signedOrderFingerprint?: string
    recoveryProbeEvidence?: Record<string, unknown>
    blocked: boolean
    occurredAt: number
    resolvedAt?: number
    resolutionNote?: string
}

export interface StrategyOrderHistoryRow {
    _id: Id<"orders">
    _creationTime: number
    orderId: string
    strategyId: Id<"strategies">
    status: OrderSnapshot["status"]
    action: OrderSnapshot["action"]
    instrument: string
    filledQuantity: number
    avgFillPrice?: number
    updatedAt: number
    intent: OrderIntent
}

export interface RawStrategyRiskStateRow {
    strategyId: string | Id<"strategies">
    app: Exclude<App, "backend">
    safetyState: StrategyRiskStateRow["safetyState"]
    dayRealizedPnl: number
    weekRealizedPnl: number
    dayDrawdownLimit?: number
    weekDrawdownLimit?: number
    dayDrawdownProgress?: number
    weekDrawdownProgress?: number
    cooldownActive: boolean
    cooldownReason?: StrategyRiskStateRow["cooldown"]["reason"]
    cooldownStartedAt?: number
    cooldownExpiresAt?: number
    unresolvedExecutionFaultCount: number
    blockedInstruments: string[]
    forcedExitClusterInstruments?: string[]
    updatedAt: number
}

export function mapStrategyRiskStateRow(
    row: RawStrategyRiskStateRow | StrategyRiskStateRow | null
): StrategyRiskStateRow | null {
    if (!row) {
        return null
    }

    if ("day" in row && "week" in row && "cooldown" in row) {
        return {
            ...row,
            strategyId: String(row.strategyId),
            forcedExitClusterInstruments: row.forcedExitClusterInstruments ?? [],
        }
    }

    return {
        strategyId: String(row.strategyId),
        app: row.app,
        safetyState: row.safetyState,
        day: {
            realizedPnl: row.dayRealizedPnl,
            limit: row.dayDrawdownLimit,
            progress: row.dayDrawdownProgress,
        },
        week: {
            realizedPnl: row.weekRealizedPnl,
            limit: row.weekDrawdownLimit,
            progress: row.weekDrawdownProgress,
        },
        cooldown: {
            active: row.cooldownActive,
            reason: row.cooldownReason,
            startedAt: row.cooldownStartedAt,
            expiresAt: row.cooldownExpiresAt,
        },
        unresolvedExecutionFaultCount: row.unresolvedExecutionFaultCount,
        blockedInstruments: row.blockedInstruments,
        forcedExitClusterInstruments: row.forcedExitClusterInstruments ?? [],
        lastUpdatedAt: row.updatedAt,
    }
}

export interface LastCompletedRunSummary {
    summary: string
    endedAt: number
    systemContextDigest?: RunSystemContextDigest
}

export interface RefreshStrategyRiskStateArgs {
    strategyId: Id<"strategies">
    app: Exclude<App, "backend">
    policy: {
        maxDrawdownDay?: number
        maxDrawdownWeek?: number
        cooldownMinutesAfterDayBreach: number
        cooldownMinutesAfterWeekBreach: number
        strategyTimezone: string
    }
}

export interface RecordExecutionSafetyFaultArgs {
    strategyId: Id<"strategies">
    app: Exclude<App, "backend">
    instrument: string
    category: ExecutionSafetyFaultRow["category"]
    message: string
    providerPayload?: string
    canonicalOrderId?: string
    providerOrderId?: string
    providerClientOrderId?: string
    providerOrderAliases?: string[]
    submitAttemptId?: string
    submitAttemptSequence?: number
    runId?: Id<"strategy_runs">
    venue?: string
    signedOrderFingerprint?: string
    recoveryProbeEvidence?: Record<string, unknown>
    blocked?: boolean
}

export interface ResolveExecutionSafetyFaultsArgs {
    strategyId: Id<"strategies">
    instrument: string
    resolutionNote?: string
}

export interface ReportHeartbeatSnapshotArgs {
    app: App
    status: "healthy" | "degraded" | "unhealthy"
    metadata: Record<string, unknown>
    force?: boolean
}

export interface ReportHeartbeatSnapshotResult {
    written: boolean
    suppressed: boolean
    metadataHash: string
    lastSnapshotAt: number
    suppressedWrites: number
}

export interface ClaimManualRunRequestsArgs {
    app: Exclude<App, "backend">
    workerId: string
    leaseMs?: number
    maxClaims?: number
    maxAttempts?: number
}

export interface ClaimManualRunRequestsResult {
    app: Exclude<App, "backend">
    claimed: ClaimedManualRunRequest[]
    contentionCount: number
    terminalizedCount: number
    maxAttempts: number
    leaseMs: number
}

export interface AckManualRunRequestArgs {
    requestId: Id<"manual_run_requests">
    workerId: string
    outcome: "completed" | "requeue" | "retryable_failure" | "terminal_failure"
    error?: string
    maxAttempts?: number
}

export interface AckManualRunRequestResult {
    status: "missing" | "already_terminal" | "completed" | "requeue" | "retryable_failure" | "terminal_failure"
}

export interface CreateAlertArgs {
    strategyId?: string
    app?: App
    severity: "critical" | "warning" | "info"
    message: string
}

export interface TradingBackendClient extends TradeEventLogger, AgentMessageLogger {
    getStrategyConfigs(app: App): Promise<StoredStrategy[]>
    getStrategyById(id: Id<"strategies">): Promise<StoredStrategy | null>
    getActiveRun(strategyId: Id<"strategies">): Promise<StoredRun | null>
    getRunHistory(strategyId: Id<"strategies">, limit?: number, beforeStartedAt?: number, beforeCreationTime?: number): Promise<StoredRun[]>
    getRunById(runId: Id<"strategy_runs">): Promise<StoredRun | null>
    getAgentLogs(runId: Id<"strategy_runs">): Promise<AgentLogRow[]>
    getAgentChatMessages(sessionId: string, limit?: number): Promise<AgentChatMessageRow[]>
    recordAgentChatUserMessage(args: RecordAgentChatUserMessageArgs): Promise<void>
    recordAgentChatAssistantMessage(args: RecordAgentChatAssistantMessageArgs): Promise<void>
    recordAgentChatToolEvent(args: RecordAgentChatToolEventArgs): Promise<void>
    getTradeEvents(runId: Id<"strategy_runs">): Promise<TradeEventRow[]>
    getLastCompletedRunSummary(strategyId: Id<"strategies">): Promise<LastCompletedRunSummary | null>
    recoverRunningRuns(): Promise<number>
    recoverStaleRunningRuns(olderThanMs?: number): Promise<number>
    createRun(strategyId: Id<"strategies">, app: App, trigger?: RunTrigger, metadata?: CreateRunMetadata): Promise<Id<"strategy_runs">>
    updateRun(
        runId: Id<"strategy_runs">,
        status: StoredRun["status"],
        summary?: string,
        error?: string,
        diagnostics?: RunDiagnostics
    ): Promise<void>
    recordRunCallback(runId: Id<"strategy_runs">, callbackRequestedMinutes: number, callbackFiresAt: number): Promise<void>
    syncPositions(strategyId: Id<"strategies">, app: App, positions: Position[]): Promise<void>
    reconcileProviderPortfolio(
        app: Exclude<App, "backend">,
        accountId: string,
        venue: string,
        source: ProviderPortfolioReconciliationResult["source"],
        accountState: AccountState,
        positions: Position[],
        workingOrders: WorkingOrder[],
        positionClosures?: ProviderPositionClosure[],
        accountPnlEvents?: AccountPnlEvent[]
    ): Promise<ProviderPortfolioReconciliationResult>
    refreshStrategyRiskState(args: RefreshStrategyRiskStateArgs): Promise<StrategyRiskStateRow>
    recordExecutionSafetyFault(args: RecordExecutionSafetyFaultArgs): Promise<string>
    resolveExecutionSafetyFaults(args: ResolveExecutionSafetyFaultsArgs): Promise<{ resolved: number }>
    recordProviderSyncFailure(app: Exclude<App, "backend">, accountId: string, error: string): Promise<void>
    resolveSecrets(keys: string[]): Promise<Record<string, string | null>>
    getCodexChatGptAuth(): Promise<CodexChatGptAuthRecord | null>
    storeCodexChatGptAuth(args: StoreCodexChatGptAuthArgs): Promise<void>
    reportHeartbeatLiveness(
        app: App,
        status: "healthy" | "degraded" | "unhealthy",
        metadata?: Record<string, unknown>
    ): Promise<void>
    reportHeartbeatSnapshot(args: ReportHeartbeatSnapshotArgs): Promise<ReportHeartbeatSnapshotResult>
    reportHeartbeat(app: App, status: "healthy" | "degraded" | "unhealthy", metadata?: Record<string, unknown>): Promise<void>
    getSystemState(): Promise<KillSwitchState>
    getControlPlaneMetrics(): Promise<ControlPlaneMetricRow[]>
    getPortfolioFreshness(app?: Exclude<App, "backend">, accountId?: string): Promise<PortfolioFreshnessRow[]>
    getPortfolioAccountSnapshots(app?: Exclude<App, "backend">, accountId?: string): Promise<PortfolioAccountSnapshotRow[]>
    getStrategyRiskState(strategyId: Id<"strategies">): Promise<StrategyRiskStateRow | null>
    getStrategyExecutionSafetyFaults(
        strategyId: Id<"strategies">,
        unresolvedOnly?: boolean
    ): Promise<ExecutionSafetyFaultRow[]>
    getStrategyOrderHistory(strategyId: Id<"strategies">, limit?: number): Promise<StrategyOrderHistoryRow[]>
    getPortfolioPositions(app?: Exclude<App, "backend">, strategyId?: Id<"strategies">, accountId?: string): Promise<ProviderPositionRow[]>
    getPortfolioPendingOrders(app?: Exclude<App, "backend">, strategyId?: Id<"strategies">, accountId?: string): Promise<ProviderPendingOrderRow[]>
    adoptProviderPositions(
        app: Exclude<App, "backend">,
        strategyId: Id<"strategies">,
        instruments: string[]
    ): Promise<AdoptProviderPositionsResult>
    getManualRunRequests(app: Exclude<App, "backend">): Promise<ManualRunRequest[]>
    getRecentAlerts(args?: GetRecentAlertsArgs): Promise<AlertRow[]>
    claimManualRunRequests(args: ClaimManualRunRequestsArgs): Promise<ClaimManualRunRequestsResult>
    ackManualRunRequest(args: AckManualRunRequestArgs): Promise<AckManualRunRequestResult>
    clearManualRunRequest(requestId: Id<"manual_run_requests">): Promise<void>
    createAlert(args: CreateAlertArgs): Promise<void>
    triggerManualRun(strategyId: Id<"strategies">): Promise<Id<"manual_run_requests">>
    triggerManualRunAsService(strategyId: Id<"strategies">): Promise<Id<"manual_run_requests">>
    acknowledgeAlert(alertId: Id<"alerts">): Promise<void>
    getStrategyOwnedInstruments(strategyId: Id<"strategies">): Promise<string[]>
    getInstrumentClaimsForStrategy(strategyId: Id<"strategies">): Promise<Array<{ instrument: string }>>
    getStrategyOwnershipScope(strategyId: Id<"strategies">): Promise<StrategyOwnershipScopeRow>
    getAllOwnedInstrumentsByApp(app: Exclude<App, "backend">, accountId: string): Promise<Array<{ instrument: string, strategyId: string }>>
    getLatestPositions(strategyId: Id<"strategies">): Promise<Position[]>
    getPositionsForRun(strategyId: Id<"strategies">, runId: Id<"strategy_runs">): Promise<Position[]>
    getAllStrategies(): Promise<StoredStrategy[]>
    getStrategyMcpToolWhitelist(strategyId: Id<"strategies">): Promise<StrategyMcpToolWhitelist | null>
    getAccounts(app?: Exclude<App, "backend">): Promise<StoredAccount[]>
    getAccountByAppAndId(app: Exclude<App, "backend">, accountId: string): Promise<StoredAccount | null>
    upsertAccount(config: AccountConfig): Promise<Id<"accounts">>
    addStrategy(config: StrategyConfig): Promise<Id<"strategies">>
    updateStrategy(id: Id<"strategies">, config: StrategyConfig): Promise<Id<"strategies">>
    disableStrategy(id: Id<"strategies">): Promise<void>
    deleteStrategy(id: Id<"strategies">): Promise<DeleteStrategyResult>
    deleteStrategyBatch(
        id: Id<"strategies">,
        batchSize?: number,
        options?: {
            allowUnverifiedEmptyProviderState?: boolean
            allowVerifiedFlatProviderState?: boolean
        }
    ): Promise<DeleteStrategyBatchResult>
    deleteAllStrategies(): Promise<DeleteAllStrategiesResult>
    deleteOrphanedStrategyHistoryBatch(batchSize?: number): Promise<DeleteOrphanedStrategyHistoryBatchResult>
    clearFullResetState(): Promise<CascadeDeleteCounts>
    clearFullResetStateBatch(
        batchSize?: number,
        preserveApps?: App[]
    ): Promise<ClearFullResetStateBatchResult>
    getFullResetAudit(): Promise<FullResetAudit>
    replaceAllStrategies(strategies: StrategyConfig[], accounts?: AccountConfig[]): Promise<ReplaceAllStrategiesResult>
}

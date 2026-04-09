import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import type { AccountState, App, ExecutionResult, OrderIntent, OrderPersistenceAdapter, OrderSnapshot, Position, StrategyConfig, ValidationResult, WorkingOrder } from "@valiq-trading/core";
export { api };
export type { Id } from "../convex/_generated/dataModel";
interface TradeEventLoggerMethods {
    logIntent(runId: string, strategyId: string, intent: OrderIntent): Promise<void>;
    logValidation(runId: string, strategyId: string, result: ValidationResult, intent: OrderIntent): Promise<void>;
    logSubmission(runId: string, strategyId: string, result: ExecutionResult, intent: OrderIntent): Promise<void>;
    logFillUpdate(runId: string, strategyId: string, result: ExecutionResult): Promise<void>;
}
export interface ConvexOrderPersistenceConfig {
    url: string;
    machineAuth?: {
        serviceToken: string;
    };
    timeoutMs?: number;
}
export interface TradingBackendClientConfig {
    url: string;
    machineAuth?: {
        serviceToken: string;
    };
    timeoutMs?: number;
}
export interface StoredStrategy {
    _id: Id<"strategies">;
    _creationTime: number;
    app: Exclude<App, "backend">;
    name: string;
    enabled: boolean;
    schedule: string;
    policy: Record<string, unknown>;
    context: string;
    createdAt?: number;
    updatedAt?: number;
}
export type RunTrigger = "cron" | "manual" | "callback";
export interface StoredRun {
    _id: Id<"strategy_runs">;
    _creationTime: number;
    strategyId: Id<"strategies">;
    app: App;
    status: "running" | "completed" | "failed";
    trigger?: RunTrigger;
    startedAt: number;
    endedAt?: number;
    summary?: string;
    error?: string;
    callbackRequestedMinutes?: number;
    callbackFiresAt?: number;
}
export interface KillSwitchState {
    globalKillSwitch: boolean;
    appKillSwitches: Record<string, boolean>;
    updatedAt: number;
}
export declare function toKillSwitchKey(app: string): string;
export interface ManualRunRequest {
    _id: Id<"manual_run_requests">;
    _creationTime: number;
    strategyId: Id<"strategies">;
    app: Exclude<App, "backend">;
    requestedAt: number;
}
export interface CascadeDeleteCounts {
    runs: number;
    agentLogs: number;
    tradeEvents: number;
    orders: number;
    orderTransitions: number;
    positions: number;
    instrumentClaims: number;
    positionSyncs: number;
    providerPositions: number;
    providerWorkingOrders: number;
    providerSyncStates: number;
    accountSnapshots: number;
    appHeartbeats: number;
    manualRunRequests: number;
    alerts: number;
}
export interface DeleteStrategyResult extends CascadeDeleteCounts {
}
export interface DeleteAllStrategiesResult extends CascadeDeleteCounts {
    strategies: number;
}
export interface ReplaceAllStrategiesResult {
    importedStrategies: number;
    deleted: DeleteAllStrategiesResult;
}
export interface ProviderPortfolioReconciliationResult {
    app: Exclude<App, "backend">;
    source: "startup_sync" | "periodic_sync" | "post_run_sync";
    positionCount: number;
    pendingOrderCount: number;
    driftDetected: boolean;
    driftSummary?: string;
}
export interface PortfolioFreshnessRow {
    app: Exclude<App, "backend">;
    accountScope: "single-account-per-venue";
    lastSyncedAt?: number;
    lastVerifiedAt?: number;
    providerStatus: "healthy" | "degraded" | "stale";
    stale: boolean;
    driftDetected: boolean;
    lastError?: string;
    lastDriftSummary?: string;
    positionCount: number;
    pendingOrderCount: number;
}
export interface ProviderPositionRow {
    app: Exclude<App, "backend">;
    strategyId?: string;
    strategyName?: string;
    ownershipStatus: "owned" | "unowned" | "orphaned";
    instrument: string;
    side: "long" | "short";
    quantity: number;
    entryPrice: number;
    currentPrice?: number;
    unrealizedPnl?: number;
    stopLoss?: number;
    takeProfit?: number;
    syncedAt: number;
    metadata?: Record<string, unknown>;
}
export interface ProviderPendingOrderRow {
    app: Exclude<App, "backend">;
    strategyId?: string;
    strategyName?: string;
    ownershipStatus: "owned" | "unowned" | "orphaned";
    orderId: string;
    instrument: string;
    venue: string;
    status: OrderSnapshot["status"];
    action?: OrderSnapshot["action"];
    quantity: number;
    filledQuantity: number;
    remainingQuantity: number;
    side?: "buy" | "sell";
    limitPrice?: number;
    stopPrice?: number;
    avgFillPrice?: number;
    submittedAt: number;
    updatedAt: number;
    metadata?: Record<string, unknown>;
}
export interface TradingBackendClient extends TradeEventLoggerMethods {
    getStrategyConfigs(app: App): Promise<StoredStrategy[]>;
    getStrategyById(id: Id<"strategies">): Promise<StoredStrategy | null>;
    getActiveRun(strategyId: Id<"strategies">): Promise<StoredRun | null>;
    getLastCompletedRunSummary(strategyId: Id<"strategies">): Promise<{
        summary: string;
        endedAt: number;
    } | null>;
    recoverRunningRuns(): Promise<number>;
    recoverStaleRunningRuns(olderThanMs?: number): Promise<number>;
    createRun(strategyId: Id<"strategies">, app: App, trigger?: RunTrigger): Promise<Id<"strategy_runs">>;
    updateRun(runId: Id<"strategy_runs">, status: StoredRun["status"], summary?: string, error?: string): Promise<void>;
    recordRunCallback(runId: Id<"strategy_runs">, callbackRequestedMinutes: number, callbackFiresAt: number): Promise<void>;
    syncPositions(strategyId: Id<"strategies">, app: App, positions: Position[]): Promise<void>;
    reconcileProviderPortfolio(app: Exclude<App, "backend">, venue: string, source: ProviderPortfolioReconciliationResult["source"], accountState: AccountState, positions: Position[], workingOrders: WorkingOrder[]): Promise<ProviderPortfolioReconciliationResult>;
    recordProviderSyncFailure(app: Exclude<App, "backend">, error: string): Promise<void>;
    log(runId: string, strategyId: string, sequence: number, role: string, content: string, toolName?: string, toolInput?: string, toolOutput?: string): Promise<void>;
    resolveSecrets(keys: string[]): Promise<Record<string, string | null>>;
    reportHeartbeat(app: App, status: "healthy" | "degraded" | "unhealthy", metadata?: Record<string, unknown>): Promise<void>;
    snapshotAccountState(app: App, venue: string, state: AccountState): Promise<void>;
    getSystemState(): Promise<KillSwitchState>;
    getPortfolioFreshness(app?: Exclude<App, "backend">): Promise<PortfolioFreshnessRow[]>;
    getPortfolioPositions(app?: Exclude<App, "backend">, strategyId?: Id<"strategies">): Promise<ProviderPositionRow[]>;
    getPortfolioPendingOrders(app?: Exclude<App, "backend">, strategyId?: Id<"strategies">): Promise<ProviderPendingOrderRow[]>;
    getManualRunRequests(app: Exclude<App, "backend">): Promise<ManualRunRequest[]>;
    clearManualRunRequest(requestId: Id<"manual_run_requests">): Promise<void>;
    createAlert(args: {
        strategyId?: string;
        app?: App;
        severity: "critical" | "warning" | "info";
        message: string;
    }): Promise<void>;
    triggerManualRun(strategyId: Id<"strategies">): Promise<Id<"manual_run_requests">>;
    acknowledgeAlert(alertId: Id<"alerts">): Promise<void>;
    getStrategyOwnedInstruments(strategyId: Id<"strategies">): Promise<string[]>;
    getAllOwnedInstrumentsByApp(app: Exclude<App, "backend">): Promise<Array<{
        instrument: string;
        strategyId: string;
    }>>;
    getLatestPositions(strategyId: Id<"strategies">): Promise<Position[]>;
    getAllStrategies(): Promise<StoredStrategy[]>;
    addStrategy(config: StrategyConfig): Promise<Id<"strategies">>;
    disableStrategy(id: Id<"strategies">): Promise<void>;
    deleteStrategy(id: Id<"strategies">): Promise<DeleteStrategyResult>;
    deleteAllStrategies(): Promise<DeleteAllStrategiesResult>;
    replaceAllStrategies(strategies: StrategyConfig[]): Promise<ReplaceAllStrategiesResult>;
}
export declare const createTradingBackendClient: (config: string | TradingBackendClientConfig) => TradingBackendClient;
export declare const createConvexOrderPersistenceAdapter: (config: ConvexOrderPersistenceConfig) => OrderPersistenceAdapter;
//# sourceMappingURL=index.d.ts.map
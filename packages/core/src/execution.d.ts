import type { AccountState, ExecutionResult, OrderIntent, OrderLifecycleContext, Position, ValidationResult, WorkingOrder } from "./types";
import { type OrderPersistenceAdapter, type OrderSnapshot, type TrackedOrderHandle, type WaitForOrderUpdateOptions, type OrderUpdateDecision, type OrderUpdateContext } from "./orders";
import { type RiskValidator } from "./risk";
import type { Logger } from "./logger";
export declare const PRICE_VERIFICATION_STATUSES: readonly ["pass", "warn", "block", "skipped"];
export type PriceVerificationStatus = typeof PRICE_VERIFICATION_STATUSES[number];
export interface PriceVerificationLivePrices {
    bid?: number;
    ask?: number;
    mid?: number;
    spread?: number;
}
export interface PriceVerification {
    ok: boolean;
    status?: PriceVerificationStatus;
    livePrices: PriceVerificationLivePrices;
    proposedPrice?: number;
    drift?: number;
    driftPercent?: number;
    warningThresholdPercent?: number;
    blockingThresholdPercent?: number;
    message: string;
    details?: Record<string, unknown>;
}
export interface PriceVerifier {
    verify(intent: OrderIntent): Promise<PriceVerification>;
}
export interface VenueAdapter {
    getPositions(): Promise<Position[]>;
    getAccountState(): Promise<AccountState>;
    getWorkingOrders?(): Promise<WorkingOrder[]>;
    submitOrder(intent: OrderIntent): Promise<ExecutionResult>;
    cancelOrder(orderId: string): Promise<ExecutionResult>;
    modifyOrder(orderId: string, changes: Partial<OrderIntent>): Promise<ExecutionResult>;
    closePosition(instrument: string, preparedIntent?: OrderIntent): Promise<ExecutionResult>;
    getOrderStatus(orderId: string): Promise<ExecutionResult>;
    buildCloseIntent?(instrument: string): Promise<OrderIntent>;
}
export interface TradeEventLogger {
    logIntent(runId: string, strategyId: string, intent: OrderIntent): Promise<void>;
    logValidation(runId: string, strategyId: string, result: ValidationResult, intent: OrderIntent): Promise<void>;
    logSubmission(runId: string, strategyId: string, result: ExecutionResult, intent: OrderIntent): Promise<void>;
    logFillUpdate(runId: string, strategyId: string, result: ExecutionResult): Promise<void>;
}
export interface ExecutionPipelineConfig {
    venue: VenueAdapter;
    venueName: string;
    policy: Record<string, unknown>;
    riskValidators?: readonly RiskValidator[];
    priceVerification?: PriceVerificationConfig;
    logger: Logger;
    tradeEventLogger?: TradeEventLogger;
    orderPersistence?: OrderPersistenceAdapter;
    runId: string;
    strategyId: string;
    lifecycle?: OrderLifecycleConfig;
    ownedInstruments?: Set<string>;
}
export interface ExecuteIntentResult {
    result: ExecutionResult;
    validation: ValidationResult;
    handle?: TrackedOrderHandle;
}
export interface ClosePositionOptions {
    estimatedPrice?: number;
}
export interface OrderLifecycleConfig {
    pollInterval?: number;
    timeout?: number;
}
export interface PriceVerificationConfig {
    warningThresholdPercent?: number;
    blockingThresholdPercent?: number;
}
export type OrderStatusCallback = (update: OrderUpdateContext) => OrderUpdateDecision | void | Promise<OrderUpdateDecision | void>;
export declare class ExecutionPipeline {
    private venue;
    private venueName;
    private policy;
    private riskValidators;
    private priceVerificationConfig;
    private logger;
    private tradeEventLogger?;
    private lifecycleManager;
    private runId;
    private strategyId;
    private ownedInstruments;
    private dryRun;
    private dryRunPositionBook;
    constructor(config: ExecutionPipelineConfig);
    executeIntent(intent: OrderIntent, accountState: AccountState, positions: Position[], lifecycleContext?: OrderLifecycleContext): Promise<ExecuteIntentResult>;
    cancelOrder(orderId: string, reason?: string): Promise<ExecutionResult>;
    modifyOrder(orderId: string, changes: Partial<OrderIntent>, reason?: string): Promise<ExecutionResult>;
    closePosition(instrument: string, reason?: string, options?: ClosePositionOptions): Promise<ExecuteIntentResult>;
    getOrderStatus(orderId: string): Promise<ExecutionResult>;
    waitForOrderUpdate(orderId: string, onUpdate: OrderStatusCallback, options?: WaitForOrderUpdateOptions): Promise<OrderSnapshot>;
    getOrderSnapshot(orderId: string): Promise<OrderSnapshot | null>;
    resumeOpenOrders(onUpdate: OrderStatusCallback): Promise<OrderSnapshot[]>;
    getTrackedOrder(orderId: string): OrderSnapshot | null;
    getTrackedOrders(): OrderSnapshot[];
    stopTracking(orderId: string): void;
    stopAllTracking(): void;
    getPositions(): Promise<Position[]>;
    seedDryRunPositions(positions: Position[]): void;
    getDryRunPositions(): Position[];
    getAccountState(): Promise<AccountState>;
    private runPriceVerification;
    private logPriceVerification;
    private netDryRunPosition;
    private updateOwnedInstruments;
    private reconcileOwnedInstrumentsFromSnapshot;
}
//# sourceMappingURL=execution.d.ts.map
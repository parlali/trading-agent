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
    TradeEventLogger,
    ValidationResult,
} from "@valiq-trading/core"

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
}

export interface TradingBackendClientConfig {
    url: string
    machineAuth?: {
        serviceToken: string
    }
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

export interface StoredRun {
    _id: Id<"strategy_runs">
    _creationTime: number
    strategyId: Id<"strategies">
    app: App
    status: "running" | "completed" | "failed"
    startedAt: number
    endedAt?: number
    summary?: string
    error?: string
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

export interface TradingBackendClient extends TradeEventLoggerMethods {
    getStrategyConfigs(app: App): Promise<StoredStrategy[]>
    createRun(strategyId: Id<"strategies">, app: App): Promise<Id<"strategy_runs">>
    updateRun(runId: Id<"strategy_runs">, status: StoredRun["status"], summary?: string, error?: string): Promise<void>
    syncPositions(strategyId: Id<"strategies">, app: App, positions: Position[]): Promise<void>
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
}

export const createTradingBackendClient = (config: string | TradingBackendClientConfig): TradingBackendClient => {
    const resolvedConfig =
        typeof config === "string"
            ? { url: config }
            : config
    const client = new ConvexHttpClient(resolvedConfig.url)

    const requireMachineAuth = (): { serviceToken: string } => {
        const serviceToken = resolvedConfig.machineAuth?.serviceToken?.trim()

        if (!serviceToken) {
            throw new Error("Machine-authenticated Convex call requires a backend service token")
        }

        return { serviceToken }
    }

    return {
        async getStrategyConfigs(app: App): Promise<StoredStrategy[]> {
            return await client.query(api.queries.getStrategyConfigs, { app } as never) as StoredStrategy[]
        },
        async createRun(strategyId: Id<"strategies">, app: App): Promise<Id<"strategy_runs">> {
            return await client.mutation(api.mutations.createRun, {
                strategyId,
                app,
            } as never) as Id<"strategy_runs">
        },
        async updateRun(
            runId: Id<"strategy_runs">,
            status: StoredRun["status"],
            summary?: string,
            error?: string
        ): Promise<void> {
            await client.mutation(api.mutations.updateRun, {
                runId,
                status,
                summary,
                error,
            })
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

            await client.mutation(api.mutations.logAgentMessage, {
                runId: runId as Id<"strategy_runs">,
                strategyId: strategyId as Id<"strategies">,
                sequence,
                role,
                content,
                toolName,
                toolInput,
                toolOutput,
            })
        },
        async logIntent(runId: string, strategyId: string, intent: OrderIntent): Promise<void> {
            await client.mutation(api.mutations.logTradeEvent, {
                runId: runId as Id<"strategy_runs">,
                strategyId: strategyId as Id<"strategies">,
                eventType: "intent",
                payload: JSON.stringify(intent),
            })
        },
        async logValidation(
            runId: string,
            strategyId: string,
            result: ValidationResult,
            intent: OrderIntent
        ): Promise<void> {
            await client.mutation(api.mutations.logTradeEvent, {
                runId: runId as Id<"strategy_runs">,
                strategyId: strategyId as Id<"strategies">,
                eventType: result.allowed ? "validation" : "rejected",
                payload: JSON.stringify({ result, intent }),
            })
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

            await client.mutation(api.mutations.logTradeEvent, {
                runId: runId as Id<"strategy_runs">,
                strategyId: strategyId as Id<"strategies">,
                eventType,
                payload: JSON.stringify({ result, intent }),
            })
        },
        async logFillUpdate(runId: string, strategyId: string, result: ExecutionResult): Promise<void> {
            const eventType = result.status === "filled" ? "filled" : "fill_update"
            await client.mutation(api.mutations.logTradeEvent, {
                runId: runId as Id<"strategy_runs">,
                strategyId: strategyId as Id<"strategies">,
                eventType,
                payload: JSON.stringify(result),
            })
        },
        async syncPositions(strategyId: Id<"strategies">, app: App, positions: Position[]): Promise<void> {
            await client.mutation(api.mutations.syncPositions, {
                strategyId,
                app: app as "alpaca-options" | "polymarket" | "mt5",
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
        },
        async resolveSecrets(keys: string[]): Promise<Record<string, string | null>> {
            return await client.action(api.actions.resolveSecrets, {
                keys,
                ...requireMachineAuth(),
            }) as Record<string, string | null>
        },
        async reportHeartbeat(app: App, status: "healthy" | "degraded" | "unhealthy", metadata?: Record<string, unknown>): Promise<void> {
            await client.mutation(api.mutations.reportHeartbeat, {
                app,
                status,
                metadata,
            } as never)
        },
        async snapshotAccountState(app: App, venue: string, state: AccountState): Promise<void> {
            await client.mutation(api.mutations.snapshotAccountState, {
                app,
                venue,
                balance: state.balance,
                buyingPower: state.buyingPower,
                marginUsed: state.marginUsed,
                marginAvailable: state.marginAvailable,
                openPnl: state.openPnl,
                dayPnl: state.dayPnl,
            } as never)
        },
        async getSystemState(): Promise<KillSwitchState> {
            return await client.query(api.queries.getSystemState, {}) as KillSwitchState
        },
        async getManualRunRequests(app: Exclude<App, "backend">): Promise<ManualRunRequest[]> {
            return await client.query(api.queries.getManualRunRequests, { app } as never) as ManualRunRequest[]
        },
        async clearManualRunRequest(requestId: Id<"manual_run_requests">): Promise<void> {
            await client.mutation(api.mutations.clearManualRunRequest, { requestId } as never)
        },
        async createAlert(args: { strategyId?: string; app?: App; severity: "critical" | "warning" | "info"; message: string }): Promise<void> {
            await client.mutation(api.mutations.createAlert, {
                strategyId: args.strategyId as Id<"strategies"> | undefined,
                app: args.app,
                severity: args.severity,
                message: args.message,
            } as never)
        },
        async triggerManualRun(strategyId: Id<"strategies">): Promise<Id<"manual_run_requests">> {
            return await client.mutation(api.mutations.triggerManualRun, { strategyId } as never) as Id<"manual_run_requests">
        },
        async acknowledgeAlert(alertId: Id<"alerts">): Promise<void> {
            await client.mutation(api.mutations.acknowledgeAlert, { alertId } as never)
        },
    }
}

export const createConvexOrderPersistenceAdapter = (
    config: ConvexOrderPersistenceConfig
): OrderPersistenceAdapter => {
    const client = new ConvexHttpClient(config.url)

    return {
        async upsertOrder(snapshot: OrderSnapshot): Promise<void> {
            await client.mutation(api.mutations.upsertOrder, {
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
        },
        async logOrderTransition(transition: OrderTransition): Promise<void> {
            await client.mutation(api.mutations.logOrderTransition, {
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
        },
        async getOrder(orderId: string): Promise<OrderSnapshot | null> {
            const order = await client.query(api.queries.getOrderById, { orderId })
            return order as OrderSnapshot | null
        },
        async listActiveOrders(strategyId: string): Promise<OrderSnapshot[]> {
            const orders = await client.query(api.queries.getActiveOrders, {
                strategyId: strategyId as Id<"strategies">,
            })
            return orders as OrderSnapshot[]
        },
        async createAlert(alert: OrderLifecycleAlert): Promise<void> {
            await client.mutation(api.mutations.createAlert, {
                strategyId: alert.strategyId as Id<"strategies">,
                severity: alert.severity,
                message: alert.message,
            })
        },
    }
}

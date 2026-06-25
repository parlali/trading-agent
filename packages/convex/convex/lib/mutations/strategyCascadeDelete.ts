import type { DatabaseWriter } from "../../_generated/server"
import type { Doc, Id } from "../../_generated/dataModel"
import {
    CASCADE_DELETE_COUNT_KEYS,
    createEmptyCascadeDeleteCounts,
    type CascadeDeleteCounts,
} from "../cascadeDelete"
import { incrementControlPlaneMetric } from "../controlPlaneMetrics"
import { deleteOrderIdentityAliasesForOrder } from "../orderIdentityAliases"

const PORTFOLIO_STALE_AFTER_MS = 10 * 60 * 1000

type MutableCascadeDeleteCounts = CascadeDeleteCounts
type StrategyDeletionSafetyOptions = {
    allowUnverifiedEmptyProviderState?: boolean
    allowVerifiedFlatProviderState?: boolean
}
export type StrategyDeleteCounts = CascadeDeleteCounts & {
    strategies: number
}

export function createEmptyStrategyDeleteCounts(): StrategyDeleteCounts {
    return {
        strategies: 0,
        ...createEmptyCascadeDeleteCounts(),
    }
}

export function addCascadeDeleteCounts(
    target: MutableCascadeDeleteCounts,
    source: Partial<CascadeDeleteCounts>
): void {
    for (const key of CASCADE_DELETE_COUNT_KEYS) {
        target[key] += source[key] ?? 0
    }
}

export async function deleteRunBatch(
    ctx: { db: DatabaseWriter },
    runId: Id<"strategy_runs">,
    deleted: MutableCascadeDeleteCounts,
    batchSize: number
): Promise<number> {
    let deletedDocuments = 0
    let remainingBudget = batchSize

    const logs = await ctx.db
        .query("agent_logs")
        .withIndex("by_run", (q) => q.eq("runId", runId))
        .take(remainingBudget)

    if (logs.length > 0) {
        for (const log of logs) {
            await ctx.db.delete(log._id)
            deleted.agentLogs++
            deletedDocuments++
            remainingBudget--
        }

        if (remainingBudget === 0) {
            return deletedDocuments
        }
    }

    const events = await ctx.db
        .query("trade_events")
        .withIndex("by_run", (q) => q.eq("runId", runId))
        .take(remainingBudget)

    if (events.length > 0) {
        for (const event of events) {
            await ctx.db.delete(event._id)
            deleted.tradeEvents++
            deletedDocuments++
            remainingBudget--
        }

        if (remainingBudget === 0) {
            return deletedDocuments
        }
    }

    while (remainingBudget > 0) {
        const order = await ctx.db
            .query("orders")
            .withIndex("by_run", (q) => q.eq("runId", runId))
            .first()

        if (!order) {
            break
        }

        const transitions = await ctx.db
            .query("order_transitions")
            .withIndex("by_order_sequence", (q) => q.eq("orderId", order.orderId))
            .take(remainingBudget)

        if (transitions.length > 0) {
            for (const transition of transitions) {
                await ctx.db.delete(transition._id)
                deleted.orderTransitions++
                deletedDocuments++
                remainingBudget--
            }

            if (remainingBudget === 0) {
                return deletedDocuments
            }
        }

        deleted.orderIdentityAliases += await deleteOrderIdentityAliasesForOrder(ctx, order._id)
        await ctx.db.delete(order._id)
        deleted.orders++
        deletedDocuments++
        remainingBudget--
    }

    if (remainingBudget === 0) {
        return deletedDocuments
    }

    await ctx.db.delete(runId)
    deleted.runs++
    deletedDocuments++

    return deletedDocuments
}

export async function deleteStrategyTableBatch(
    ctx: { db: DatabaseWriter },
    strategyId: Id<"strategies">,
    app: Doc<"strategies">["app"],
    deleted: MutableCascadeDeleteCounts,
    batchSize: number
): Promise<boolean> {
    const positions = await ctx.db
        .query("positions")
        .withIndex("by_strategy", (q) => q.eq("strategyId", strategyId))
        .take(batchSize)

    if (positions.length > 0) {
        for (const position of positions) {
            await ctx.db.delete(position._id)
            deleted.positions++
        }
        return true
    }

    const claims = await ctx.db
        .query("instrument_claims")
        .withIndex("by_strategy", (q) => q.eq("strategyId", strategyId))
        .take(batchSize)

    if (claims.length > 0) {
        for (const claim of claims) {
            await ctx.db.delete(claim._id)
            deleted.instrumentClaims++
        }
        return true
    }

    const syncs = await ctx.db
        .query("position_syncs")
        .withIndex("by_strategy_synced_at", (q) => q.eq("strategyId", strategyId))
        .take(batchSize)

    if (syncs.length > 0) {
        for (const sync of syncs) {
            await ctx.db.delete(sync._id)
            deleted.positionSyncs++
        }
        return true
    }

    const riskStates = await ctx.db
        .query("strategy_risk_states")
        .withIndex("by_strategy", (q) => q.eq("strategyId", strategyId))
        .take(batchSize)

    if (riskStates.length > 0) {
        for (const riskState of riskStates) {
            await ctx.db.delete(riskState._id)
            deleted.strategyRiskStates++
        }
        return true
    }

    const executionFaults = await ctx.db
        .query("execution_safety_faults")
        .withIndex("by_strategy", (q) => q.eq("strategyId", strategyId))
        .take(batchSize)

    if (executionFaults.length > 0) {
        for (const fault of executionFaults) {
            await ctx.db.delete(fault._id)
            deleted.executionSafetyFaults++
        }
        return true
    }

    const providerPositions = await ctx.db
        .query("provider_positions")
        .withIndex("by_app_strategy", (q) =>
            q.eq("app", app).eq("strategyId", strategyId)
        )
        .take(batchSize)

    if (providerPositions.length > 0) {
        for (const position of providerPositions) {
            await ctx.db.delete(position._id)
            deleted.providerPositions++
        }
        return true
    }

    const providerPositionHistory = await ctx.db
        .query("provider_position_history")
        .withIndex("by_app_strategy", (q) =>
            q.eq("app", app).eq("strategyId", strategyId)
        )
        .take(batchSize)

    if (providerPositionHistory.length > 0) {
        for (const position of providerPositionHistory) {
            await ctx.db.delete(position._id)
            deleted.providerPositions++
        }
        return true
    }

    const providerWorkingOrders = await ctx.db
        .query("provider_working_orders")
        .withIndex("by_app_strategy", (q) =>
            q.eq("app", app).eq("strategyId", strategyId)
        )
        .take(batchSize)

    if (providerWorkingOrders.length > 0) {
        for (const order of providerWorkingOrders) {
            await ctx.db.delete(order._id)
            deleted.providerWorkingOrders++
        }
        return true
    }

    const manualRunRequests = await ctx.db
        .query("manual_run_requests")
        .withIndex("by_strategy", (q) => q.eq("strategyId", strategyId))
        .take(batchSize)

    if (manualRunRequests.length > 0) {
        for (const request of manualRunRequests) {
            await ctx.db.delete(request._id)
            deleted.manualRunRequests++
        }
        return true
    }

    const mcpToolWhitelists = await ctx.db
        .query("strategy_mcp_tool_whitelists")
        .withIndex("by_strategy", (q) => q.eq("strategyId", strategyId))
        .take(batchSize)

    if (mcpToolWhitelists.length > 0) {
        for (const whitelist of mcpToolWhitelists) {
            await ctx.db.delete(whitelist._id)
            deleted.strategyMcpToolWhitelists++
        }
        return true
    }

    const strategy = await ctx.db.get(strategyId)

    if (!strategy) {
        return false
    }

    const accountStrategies = await ctx.db
        .query("strategies")
        .withIndex("by_app_account", (q) =>
            q.eq("app", app).eq("accountId", strategy.accountId)
        )
        .take(2)
    const isLastStrategyForAccount = accountStrategies.length === 1

    if (!isLastStrategyForAccount) {
        return false
    }

    const remainingProviderPositions = await ctx.db
        .query("provider_positions")
        .withIndex("by_app_account", (q) =>
            q.eq("app", app).eq("accountId", strategy.accountId)
        )
        .take(batchSize)

    if (remainingProviderPositions.length > 0) {
        for (const position of remainingProviderPositions) {
            await ctx.db.delete(position._id)
            deleted.providerPositions++
        }
        return true
    }

    const remainingProviderPositionHistory = await ctx.db
        .query("provider_position_history")
        .withIndex("by_app_account", (q) =>
            q.eq("app", app).eq("accountId", strategy.accountId)
        )
        .take(batchSize)

    if (remainingProviderPositionHistory.length > 0) {
        for (const position of remainingProviderPositionHistory) {
            await ctx.db.delete(position._id)
            deleted.providerPositions++
        }
        return true
    }

    const remainingProviderWorkingOrders = await ctx.db
        .query("provider_working_orders")
        .withIndex("by_app_account", (q) =>
            q.eq("app", app).eq("accountId", strategy.accountId)
        )
        .take(batchSize)

    if (remainingProviderWorkingOrders.length > 0) {
        for (const order of remainingProviderWorkingOrders) {
            await ctx.db.delete(order._id)
            deleted.providerWorkingOrders++
        }
        return true
    }

    return false
}

export async function deleteFinalStrategyAccountRows(
    ctx: { db: DatabaseWriter },
    strategy: Doc<"strategies">,
    deleted: MutableCascadeDeleteCounts
): Promise<void> {
    const accountStrategies = await ctx.db
        .query("strategies")
        .withIndex("by_app_account", (q) =>
            q.eq("app", strategy.app).eq("accountId", strategy.accountId)
        )
        .take(2)

    if (accountStrategies.length !== 1) {
        return
    }

    const syncStates = await ctx.db
        .query("provider_sync_state")
        .withIndex("by_app_account", (q) =>
            q.eq("app", strategy.app).eq("accountId", strategy.accountId)
        )
        .collect()

    for (const syncState of syncStates) {
        await ctx.db.delete(syncState._id)
        deleted.providerSyncStates++
    }
}

export async function deleteFinalStrategyAppRows(
    ctx: { db: DatabaseWriter },
    app: Doc<"strategies">["app"],
    deleted: MutableCascadeDeleteCounts
): Promise<void> {
    const appStrategies = await ctx.db
        .query("strategies")
        .withIndex("by_app", (q) => q.eq("app", app))
        .take(2)

    if (appStrategies.length !== 1) {
        return
    }

    const heartbeat = await ctx.db
        .query("app_heartbeats")
        .withIndex("by_app", (q) => q.eq("app", app))
        .first()

    if (heartbeat) {
        await ctx.db.delete(heartbeat._id)
        deleted.appHeartbeats++
    }
}

export async function cascadeDeleteRun(
    ctx: { db: DatabaseWriter },
    runId: Id<"strategy_runs">
): Promise<{
    agentLogs: number
    tradeEvents: number
    orders: number
    orderIdentityAliases: number
    orderTransitions: number
}> {
    let agentLogs = 0
    let tradeEvents = 0
    let orders = 0
    let orderIdentityAliases = 0
    let orderTransitions = 0

    const logs = await ctx.db
        .query("agent_logs")
        .withIndex("by_run", (q) => q.eq("runId", runId))
        .collect()
    for (const log of logs) {
        await ctx.db.delete(log._id)
        agentLogs++
    }

    const events = await ctx.db
        .query("trade_events")
        .withIndex("by_run", (q) => q.eq("runId", runId))
        .collect()
    for (const event of events) {
        await ctx.db.delete(event._id)
        tradeEvents++
    }

    const runOrders = await ctx.db
        .query("orders")
        .withIndex("by_run", (q) => q.eq("runId", runId))
        .collect()
    for (const order of runOrders) {
        const transitions = await ctx.db
            .query("order_transitions")
            .withIndex("by_order_sequence", (q) => q.eq("orderId", order.orderId))
            .collect()
        for (const t of transitions) {
            await ctx.db.delete(t._id)
            orderTransitions++
        }
        orderIdentityAliases += await deleteOrderIdentityAliasesForOrder(ctx, order._id)
        await ctx.db.delete(order._id)
        orders++
    }

    await ctx.db.delete(runId)

    return {
        agentLogs,
        tradeEvents,
        orders,
        orderIdentityAliases,
        orderTransitions,
    }
}

export async function cascadeDeleteStrategy(
    ctx: { db: DatabaseWriter },
    strategyId: Id<"strategies">
): Promise<CascadeDeleteCounts> {
    const strategy = await ctx.db.get(strategyId)

    if (!strategy) {
        throw new Error(`Strategy not found: ${strategyId}`)
    }

    let runs = 0
    let agentLogs = 0
    let tradeEvents = 0
    let orders = 0
    let orderIdentityAliases = 0
    let orderTransitions = 0
    let positions = 0
    let instrumentClaims = 0
    let positionSyncs = 0
    let strategyRiskStates = 0
    let executionSafetyFaults = 0
    let providerPositions = 0
    let providerWorkingOrders = 0
    let providerSyncStates = 0
    let accountSnapshots = 0
    let appHeartbeats = 0
    let manualRunRequests = 0
    let strategyMcpToolWhitelists = 0
    let alerts = 0

    const strategyRuns = await ctx.db
        .query("strategy_runs")
        .withIndex("by_strategy", (q) => q.eq("strategyId", strategyId))
        .collect()

    for (const run of strategyRuns) {
        const deleted = await cascadeDeleteRun(ctx, run._id)
        runs++
        agentLogs += deleted.agentLogs
        tradeEvents += deleted.tradeEvents
        orders += deleted.orders
        orderIdentityAliases += deleted.orderIdentityAliases
        orderTransitions += deleted.orderTransitions
    }

    const strategyPositions = await ctx.db
        .query("positions")
        .withIndex("by_strategy", (q) => q.eq("strategyId", strategyId))
        .collect()

    for (const position of strategyPositions) {
        await ctx.db.delete(position._id)
        positions++
    }

    const strategyClaims = await ctx.db
        .query("instrument_claims")
        .withIndex("by_strategy", (q) => q.eq("strategyId", strategyId))
        .collect()

    for (const claim of strategyClaims) {
        await ctx.db.delete(claim._id)
        instrumentClaims++
    }

    const strategySyncs = await ctx.db
        .query("position_syncs")
        .withIndex("by_strategy_synced_at", (q) => q.eq("strategyId", strategyId))
        .collect()

    for (const sync of strategySyncs) {
        await ctx.db.delete(sync._id)
        positionSyncs++
    }

    const strategyRiskRows = await ctx.db
        .query("strategy_risk_states")
        .withIndex("by_strategy", (q) => q.eq("strategyId", strategyId))
        .collect()

    for (const riskRow of strategyRiskRows) {
        await ctx.db.delete(riskRow._id)
        strategyRiskStates++
    }

    const strategyExecutionFaults = await ctx.db
        .query("execution_safety_faults")
        .withIndex("by_strategy", (q) => q.eq("strategyId", strategyId))
        .collect()

    for (const fault of strategyExecutionFaults) {
        await ctx.db.delete(fault._id)
        executionSafetyFaults++
    }

    const strategyProviderPositions = await ctx.db
        .query("provider_positions")
        .withIndex("by_app_strategy", (q) =>
            q.eq("app", strategy.app).eq("strategyId", strategyId)
        )
        .collect()

    for (const position of strategyProviderPositions) {
        await ctx.db.delete(position._id)
        providerPositions++
    }

    const strategyProviderPositionHistory = await ctx.db
        .query("provider_position_history")
        .withIndex("by_app_strategy", (q) =>
            q.eq("app", strategy.app).eq("strategyId", strategyId)
        )
        .collect()

    for (const position of strategyProviderPositionHistory) {
        await ctx.db.delete(position._id)
        providerPositions++
    }

    const strategyProviderWorkingOrders = await ctx.db
        .query("provider_working_orders")
        .withIndex("by_app_strategy", (q) =>
            q.eq("app", strategy.app).eq("strategyId", strategyId)
        )
        .collect()

    for (const order of strategyProviderWorkingOrders) {
        await ctx.db.delete(order._id)
        providerWorkingOrders++
    }

    const strategyManualRunRequests = await ctx.db
        .query("manual_run_requests")
        .withIndex("by_strategy", (q) => q.eq("strategyId", strategyId))
        .collect()

    for (const request of strategyManualRunRequests) {
        await ctx.db.delete(request._id)
        manualRunRequests++
    }

    const strategyMcpToolWhitelistRows = await ctx.db
        .query("strategy_mcp_tool_whitelists")
        .withIndex("by_strategy", (q) => q.eq("strategyId", strategyId))
        .collect()

    for (const whitelist of strategyMcpToolWhitelistRows) {
        await ctx.db.delete(whitelist._id)
        strategyMcpToolWhitelists++
    }

    const strategyAlerts = (await ctx.db.query("alerts").collect()).filter(
        (alert) => alert.strategyId === strategyId
    )

    for (const alert of strategyAlerts) {
        await ctx.db.delete(alert._id)
        alerts++
    }

    const accountStrategies = await ctx.db
        .query("strategies")
        .withIndex("by_app_account", (q) =>
            q.eq("app", strategy.app).eq("accountId", strategy.accountId)
        )
        .collect()
    const isLastStrategyForAccount = accountStrategies.length === 1

    if (isLastStrategyForAccount) {
        const remainingProviderPositions = await ctx.db
            .query("provider_positions")
            .withIndex("by_app_account", (q) =>
                q.eq("app", strategy.app).eq("accountId", strategy.accountId)
            )
            .collect()

        for (const position of remainingProviderPositions) {
            await ctx.db.delete(position._id)
            providerPositions++
        }

        const remainingProviderPositionHistory = await ctx.db
            .query("provider_position_history")
            .withIndex("by_app_account", (q) =>
                q.eq("app", strategy.app).eq("accountId", strategy.accountId)
            )
            .collect()

        for (const position of remainingProviderPositionHistory) {
            await ctx.db.delete(position._id)
            providerPositions++
        }

        const remainingProviderWorkingOrders = await ctx.db
            .query("provider_working_orders")
            .withIndex("by_app_account", (q) =>
                q.eq("app", strategy.app).eq("accountId", strategy.accountId)
            )
            .collect()

        for (const order of remainingProviderWorkingOrders) {
            await ctx.db.delete(order._id)
            providerWorkingOrders++
        }

        const remainingProviderSyncStates = await ctx.db
            .query("provider_sync_state")
            .withIndex("by_app_account", (q) =>
                q.eq("app", strategy.app).eq("accountId", strategy.accountId)
            )
            .collect()

        for (const syncState of remainingProviderSyncStates) {
            await ctx.db.delete(syncState._id)
            providerSyncStates++
        }
    }

    const appStrategies = await ctx.db
        .query("strategies")
        .withIndex("by_app", (q) => q.eq("app", strategy.app))
        .collect()
    const isLastStrategyForApp = appStrategies.length === 1

    if (isLastStrategyForApp) {
        const heartbeat = await ctx.db
            .query("app_heartbeats")
            .withIndex("by_app", (q) => q.eq("app", strategy.app))
            .first()

        if (heartbeat) {
            await ctx.db.delete(heartbeat._id)
            appHeartbeats++
        }
    }

    await ctx.db.delete(strategyId)

    return {
        runs,
        agentLogs,
        tradeEvents,
        orders,
        orderIdentityAliases,
        orderTransitions,
        positions,
        instrumentClaims,
        positionSyncs,
        strategyRiskStates,
        executionSafetyFaults,
        providerPositions,
        providerWorkingOrders,
        providerSyncStates,
        accountSnapshots,
        appHeartbeats,
        manualRunRequests,
        strategyMcpToolWhitelists,
        alerts,
    }
}


export async function assertStrategyDeletionSafe(
    ctx: { db: DatabaseWriter },
    strategy: Doc<"strategies">,
    options: StrategyDeletionSafetyOptions = {}
): Promise<void> {
    const isDryRun = strategy.policy?.dryRun === true
    const [activeRun, providerState, trackedPositions, trackedWorkingOrders, pendingOrders, partiallyFilledOrders] = await Promise.all([
        ctx.db
            .query("strategy_runs")
            .withIndex("by_strategy_status", (q) =>
                q.eq("strategyId", strategy._id).eq("status", "running")
            )
            .first(),
        ctx.db
            .query("provider_sync_state")
            .withIndex("by_app_account", (q) =>
                q.eq("app", strategy.app).eq("accountId", strategy.accountId)
            )
            .first(),
        ctx.db
            .query("provider_positions")
            .withIndex("by_app_strategy", (q) =>
                q.eq("app", strategy.app).eq("strategyId", strategy._id)
            )
            .collect(),
        ctx.db
            .query("provider_working_orders")
            .withIndex("by_app_strategy", (q) =>
                q.eq("app", strategy.app).eq("strategyId", strategy._id)
            )
            .collect(),
        ctx.db
            .query("orders")
            .withIndex("by_strategy_status", (q) =>
                q.eq("strategyId", strategy._id).eq("status", "pending")
            )
            .collect(),
        ctx.db
            .query("orders")
            .withIndex("by_strategy_status", (q) =>
                q.eq("strategyId", strategy._id).eq("status", "partially_filled")
            )
            .collect(),
    ])

    if (activeRun) {
        throw new Error("Cannot delete a strategy with an active run")
    }

    const providerStateIsUnsafe = !providerState ||
        providerState.lastVerifiedAt === undefined ||
        providerState.driftDetected ||
        providerState.providerStatus !== "healthy" ||
        isPortfolioStateStale(providerState.lastVerifiedAt)

    const hasTrackedProviderExposure =
        trackedPositions.length > 0 ||
        trackedWorkingOrders.length > 0 ||
        pendingOrders.length > 0 ||
        partiallyFilledOrders.length > 0
    const hasPendingOrderLifecycle =
        pendingOrders.length > 0 ||
        partiallyFilledOrders.length > 0
    const allowUnsafeProviderState =
        (
            options.allowUnverifiedEmptyProviderState === true &&
            !hasTrackedProviderExposure
        ) ||
        (
            options.allowVerifiedFlatProviderState === true &&
            !hasPendingOrderLifecycle
        )

    if (
        !isDryRun &&
        providerStateIsUnsafe &&
        !allowUnsafeProviderState
    ) {
        throw new Error(
            `Cannot delete strategy while ${strategy.app} provider ownership has not been recently verified, is stale, or is drifted. Run the backend-admin reset flow after operator review.`
        )
    }

    if (
        !isDryRun &&
        (trackedPositions.length > 0 || trackedWorkingOrders.length > 0) &&
        options.allowVerifiedFlatProviderState !== true
    ) {
        throw new Error(
            `Cannot delete strategy with live provider-tracked exposure or working orders. Run the backend-admin reset flow first.`
        )
    }

    if (!isDryRun && (pendingOrders.length > 0 || partiallyFilledOrders.length > 0)) {
        throw new Error(
            "Cannot delete strategy with pending or partially filled orders in Convex state. Run the backend-admin reset flow first."
        )
    }
}

function isPortfolioStateStale(lastVerifiedAt: number | undefined): boolean {
    if (!lastVerifiedAt) {
        return true
    }

    return Date.now() - lastVerifiedAt > PORTFOLIO_STALE_AFTER_MS
}

export function sumDeletedCounts(counts: CascadeDeleteCounts): number {
    return CASCADE_DELETE_COUNT_KEYS.reduce(
        (total, key) => total + counts[key],
        0
    )
}

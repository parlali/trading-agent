import { mutation } from "../../_generated/server"
import type { DatabaseWriter } from "../../_generated/server"
import type { Doc, Id } from "../../_generated/dataModel"
import { v } from "convex/values"
import { validateStrategyConfig } from "@valiq-trading/core"
import { requireUser, requireServiceToken } from "../authGuards"
import { createEmptyCascadeDeleteCounts, type CascadeDeleteCounts } from "../cascadeDelete"
import { incrementControlPlaneMetric } from "../controlPlaneMetrics"

const PORTFOLIO_STALE_AFTER_MS = 10 * 60 * 1000

const venueAppArg = v.union(
    v.literal("alpaca-options"),
    v.literal("polymarket"),
    v.literal("mt5"),
    v.literal("binance-futures")
)

const strategyImportArg = v.object({
    app: venueAppArg,
    name: v.string(),
    enabled: v.boolean(),
    schedule: v.string(),
    policy: v.any(),
    context: v.string(),
})

export const upsertStrategy = mutation({
    args: {
        id: v.optional(v.id("strategies")),
        app: venueAppArg,
        name: v.string(),
        enabled: v.boolean(),
        schedule: v.string(),
        policy: v.any(),
        context: v.string(),
        serviceToken: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        if (args.serviceToken) {
            requireServiceToken(args.serviceToken)
        } else {
            await requireUser(ctx)
        }

        const strategy = validateStrategyConfig({
            app: args.app,
            name: args.name,
            enabled: args.enabled,
            schedule: args.schedule,
            policy: args.policy,
            context: args.context,
        })

        const now = Date.now()
        if (args.id) {
            await ctx.db.patch(args.id, {
                app: strategy.app,
                name: strategy.name,
                enabled: strategy.enabled,
                schedule: strategy.schedule,
                policy: strategy.policy,
                context: strategy.context,
                updatedAt: now,
            })
            return args.id
        }
        return await ctx.db.insert("strategies", {
            app: strategy.app,
            name: strategy.name,
            enabled: strategy.enabled,
            schedule: strategy.schedule,
            policy: strategy.policy,
            context: strategy.context,
            createdAt: now,
            updatedAt: now,
        })
    },
})

export const disableStrategy = mutation({
    args: {
        strategyId: v.id("strategies"),
        serviceToken: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        if (args.serviceToken) {
            requireServiceToken(args.serviceToken)
        } else {
            await requireUser(ctx)
        }
        await ctx.db.patch(args.strategyId, { enabled: false })
    },
})

export const deleteStrategy = mutation({
    args: {
        strategyId: v.id("strategies"),
        serviceToken: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        if (args.serviceToken) {
            requireServiceToken(args.serviceToken)
        } else {
            await requireUser(ctx)
        }
        const strategy = await ctx.db.get(args.strategyId)
        if (!strategy) {
            throw new Error(`Strategy not found: ${args.strategyId}`)
        }

        const activeRun = await ctx.db
            .query("strategy_runs")
            .withIndex("by_strategy_status", (q) =>
                q.eq("strategyId", args.strategyId).eq("status", "running")
            )
            .first()

        if (activeRun) {
            throw new Error("Cannot delete a strategy with an active run")
        }

        await assertStrategyDeletionSafe(ctx, strategy)

        return await cascadeDeleteStrategy(ctx, args.strategyId)
    },
})

export const deleteStrategyBatch = mutation({
    args: {
        strategyId: v.id("strategies"),
        serviceToken: v.optional(v.string()),
        batchSize: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
        if (args.serviceToken) {
            requireServiceToken(args.serviceToken)
        } else {
            await requireUser(ctx)
        }

        const deleted = createEmptyCascadeDeleteCounts()
        const strategy = await ctx.db.get(args.strategyId)

        if (!strategy) {
            return {
                ...deleted,
                strategyDeleted: false,
                hasMore: false,
            }
        }

        await assertStrategyDeletionSafe(ctx, strategy)

        const batchSize = Math.max(1, Math.min(args.batchSize ?? 20, 50))
        await incrementControlPlaneMetric(ctx, {
            metric: "maintenance.delete_strategy_batch.invocation",
            app: strategy.app,
        })
        await incrementControlPlaneMetric(ctx, {
            metric: "maintenance.delete_strategy_batch.batch_size",
            app: strategy.app,
            delta: batchSize,
        })
        let remainingBudget = batchSize
        let deletedRunRows = 0

        while (remainingBudget > 0) {
            const strategyRun = await ctx.db
                .query("strategy_runs")
                .withIndex("by_strategy", (q) => q.eq("strategyId", args.strategyId))
                .first()

            if (!strategyRun) {
                break
            }

            const deletedThisRun = await deleteRunBatch(ctx, strategyRun._id, deleted, remainingBudget)

            if (deletedThisRun === 0) {
                break
            }

            remainingBudget -= deletedThisRun
            deletedRunRows += deletedThisRun
        }

        if (deletedRunRows > 0) {
            await incrementControlPlaneMetric(ctx, {
                metric: "maintenance.delete_strategy_batch.deleted_docs",
                app: strategy.app,
                delta: sumDeletedCounts(deleted),
            })
            return {
                ...deleted,
                strategyDeleted: false,
                hasMore: true,
            }
        }

        if (await deleteStrategyTableBatch(ctx, args.strategyId, strategy.app, deleted, batchSize)) {
            await incrementControlPlaneMetric(ctx, {
                metric: "maintenance.delete_strategy_batch.deleted_docs",
                app: strategy.app,
                delta: sumDeletedCounts(deleted),
            })
            return {
                ...deleted,
                strategyDeleted: false,
                hasMore: true,
            }
        }

        await ctx.db.delete(args.strategyId)
        await incrementControlPlaneMetric(ctx, {
            metric: "maintenance.delete_strategy_batch.deleted_docs",
            app: strategy.app,
            delta: sumDeletedCounts(deleted) + 1,
        })

        return {
            ...deleted,
            strategyDeleted: true,
            hasMore: false,
        }
    },
})

export const deleteAllStrategies = mutation({
    args: {
        serviceToken: v.string(),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)

        const deleted = {
            strategies: 0,
            runs: 0,
            agentLogs: 0,
            tradeEvents: 0,
            orders: 0,
            orderTransitions: 0,
            positions: 0,
            instrumentClaims: 0,
            positionSyncs: 0,
            providerPositions: 0,
            providerWorkingOrders: 0,
            providerSyncStates: 0,
            accountSnapshots: 0,
            appHeartbeats: 0,
            manualRunRequests: 0,
            alerts: 0,
        }

        const existingStrategies = await ctx.db.query("strategies").collect()

        for (const strategy of existingStrategies) {
            await assertStrategyDeletionSafe(ctx, strategy)
        }

        for (const strategy of existingStrategies) {
            const result = await cascadeDeleteStrategy(ctx, strategy._id)
            deleted.strategies++
            deleted.runs += result.runs
            deleted.agentLogs += result.agentLogs
            deleted.tradeEvents += result.tradeEvents
            deleted.orders += result.orders
            deleted.orderTransitions += result.orderTransitions
            deleted.positions += result.positions
            deleted.instrumentClaims += result.instrumentClaims
            deleted.positionSyncs += result.positionSyncs
            deleted.providerPositions += result.providerPositions
            deleted.providerWorkingOrders += result.providerWorkingOrders
            deleted.providerSyncStates += result.providerSyncStates
            deleted.accountSnapshots += result.accountSnapshots
            deleted.appHeartbeats += result.appHeartbeats
            deleted.manualRunRequests += result.manualRunRequests
            deleted.alerts += result.alerts
        }

        return deleted
    },
})

export const deleteOrphanedStrategyHistoryBatch = mutation({
    args: {
        serviceToken: v.string(),
        batchSize: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)

        const batchSize = Math.max(1, Math.min(args.batchSize ?? 100, 250))
        await incrementControlPlaneMetric(ctx, {
            metric: "maintenance.orphan_cleanup_batch.invocation",
        })
        await incrementControlPlaneMetric(ctx, {
            metric: "maintenance.orphan_cleanup_batch.batch_size",
            delta: batchSize,
        })
        const deleted = {
            runs: 0,
            agentLogs: 0,
            tradeEvents: 0,
            orders: 0,
            orderTransitions: 0,
            positions: 0,
            instrumentClaims: 0,
            positionSyncs: 0,
            providerPositions: 0,
            providerWorkingOrders: 0,
            providerSyncStates: 0,
            accountSnapshots: 0,
            appHeartbeats: 0,
            manualRunRequests: 0,
            alerts: 0,
        }

        const strategyExistsCache = new Map<string, boolean>()
        const runExistsCache = new Map<string, boolean>()
        const orderExistsCache = new Map<string, boolean>()

        const strategyExists = async (strategyId: Id<"strategies"> | undefined): Promise<boolean> => {
            if (!strategyId) {
                return false
            }

            const key = String(strategyId)
            const cached = strategyExistsCache.get(key)
            if (cached !== undefined) {
                return cached
            }

            const exists = (await ctx.db.get(strategyId)) !== null
            strategyExistsCache.set(key, exists)
            return exists
        }

        const runExists = async (runId: Id<"strategy_runs"> | undefined): Promise<boolean> => {
            if (!runId) {
                return false
            }

            const key = String(runId)
            const cached = runExistsCache.get(key)
            if (cached !== undefined) {
                return cached
            }

            const exists = (await ctx.db.get(runId)) !== null
            runExistsCache.set(key, exists)
            return exists
        }

        const orderExists = async (orderId: string | undefined): Promise<boolean> => {
            if (!orderId) {
                return false
            }

            const cached = orderExistsCache.get(orderId)
            if (cached !== undefined) {
                return cached
            }

            const exists = await ctx.db
                .query("orders")
                .withIndex("by_order_id", (q) => q.eq("orderId", orderId))
                .first()

            const result = exists !== null
            orderExistsCache.set(orderId, result)
            return result
        }

        const deleteOrderWithTransitions = async (
            order: Doc<"orders">
        ): Promise<void> => {
            const transitions = await ctx.db
                .query("order_transitions")
                .withIndex("by_order_sequence", (q) => q.eq("orderId", order.orderId))
                .collect()

            for (const transition of transitions) {
                await ctx.db.delete(transition._id)
                deleted.orderTransitions++
            }

            await ctx.db.delete(order._id)
            deleted.orders++
            orderExistsCache.set(order.orderId, false)
        }

        const orphanRuns = await ctx.db.query("strategy_runs").order("asc").take(batchSize)
        for (const run of orphanRuns) {
            if (await strategyExists(run.strategyId)) {
                continue
            }

            const result = await cascadeDeleteRun(ctx, run._id)
            deleted.runs++
            deleted.agentLogs += result.agentLogs
            deleted.tradeEvents += result.tradeEvents
            deleted.orders += result.orders
            deleted.orderTransitions += result.orderTransitions
            runExistsCache.set(String(run._id), false)
        }

        if (sumDeletedCounts(deleted) > 0) {
            await incrementControlPlaneMetric(ctx, {
                metric: "maintenance.orphan_cleanup_batch.deleted_docs",
                delta: sumDeletedCounts(deleted),
            })
            return {
                ...deleted,
                hasMore: true,
            }
        }

        const orphanLogs = await ctx.db.query("agent_logs").order("asc").take(batchSize)
        for (const log of orphanLogs) {
            if (await strategyExists(log.strategyId) && await runExists(log.runId)) {
                continue
            }

            await ctx.db.delete(log._id)
            deleted.agentLogs++
        }

        if (sumDeletedCounts(deleted) > 0) {
            return {
                ...deleted,
                hasMore: true,
            }
        }

        const orphanEvents = await ctx.db.query("trade_events").order("asc").take(batchSize)
        for (const event of orphanEvents) {
            if (await strategyExists(event.strategyId) && await runExists(event.runId)) {
                continue
            }

            await ctx.db.delete(event._id)
            deleted.tradeEvents++
        }

        if (sumDeletedCounts(deleted) > 0) {
            return {
                ...deleted,
                hasMore: true,
            }
        }

        const orphanOrders = await ctx.db.query("orders").order("asc").take(batchSize)
        for (const order of orphanOrders) {
            if (await strategyExists(order.strategyId) && await runExists(order.runId)) {
                continue
            }

            await deleteOrderWithTransitions(order)
        }

        if (sumDeletedCounts(deleted) > 0) {
            return {
                ...deleted,
                hasMore: true,
            }
        }

        const orphanTransitions = await ctx.db.query("order_transitions").order("asc").take(batchSize)
        for (const transition of orphanTransitions) {
            if (
                await strategyExists(transition.strategyId) &&
                await runExists(transition.runId) &&
                await orderExists(transition.orderId)
            ) {
                continue
            }

            await ctx.db.delete(transition._id)
            deleted.orderTransitions++
        }

        if (sumDeletedCounts(deleted) > 0) {
            return {
                ...deleted,
                hasMore: true,
            }
        }

        const orphanPositions = await ctx.db.query("positions").order("asc").take(batchSize)
        for (const position of orphanPositions) {
            if (await strategyExists(position.strategyId)) {
                continue
            }

            await ctx.db.delete(position._id)
            deleted.positions++
        }

        if (sumDeletedCounts(deleted) > 0) {
            return {
                ...deleted,
                hasMore: true,
            }
        }

        const orphanClaims = await ctx.db.query("instrument_claims").order("asc").take(batchSize)
        for (const claim of orphanClaims) {
            if (await strategyExists(claim.strategyId)) {
                continue
            }

            await ctx.db.delete(claim._id)
            deleted.instrumentClaims++
        }

        if (sumDeletedCounts(deleted) > 0) {
            return {
                ...deleted,
                hasMore: true,
            }
        }

        const orphanSyncs = await ctx.db.query("position_syncs").order("asc").take(batchSize)
        for (const sync of orphanSyncs) {
            if (await strategyExists(sync.strategyId)) {
                continue
            }

            await ctx.db.delete(sync._id)
            deleted.positionSyncs++
        }

        if (sumDeletedCounts(deleted) > 0) {
            return {
                ...deleted,
                hasMore: true,
            }
        }

        const orphanProviderPositions = await ctx.db.query("provider_positions").order("asc").take(batchSize)
        for (const position of orphanProviderPositions) {
            if (!position.strategyId || await strategyExists(position.strategyId)) {
                continue
            }

            await ctx.db.delete(position._id)
            deleted.providerPositions++
        }

        if (sumDeletedCounts(deleted) > 0) {
            return {
                ...deleted,
                hasMore: true,
            }
        }

        const orphanProviderOrders = await ctx.db.query("provider_working_orders").order("asc").take(batchSize)
        for (const order of orphanProviderOrders) {
            const hasValidStrategy = !order.strategyId || await strategyExists(order.strategyId)
            const hasValidRun = !order.runId || await runExists(order.runId)

            if (hasValidStrategy && hasValidRun) {
                continue
            }

            await ctx.db.delete(order._id)
            deleted.providerWorkingOrders++
        }

        if (sumDeletedCounts(deleted) > 0) {
            return {
                ...deleted,
                hasMore: true,
            }
        }

        const orphanManualRequests = await ctx.db.query("manual_run_requests").order("asc").take(batchSize)
        for (const request of orphanManualRequests) {
            if (await strategyExists(request.strategyId)) {
                continue
            }

            await ctx.db.delete(request._id)
            deleted.manualRunRequests++
        }

        if (sumDeletedCounts(deleted) > 0) {
            return {
                ...deleted,
                hasMore: true,
            }
        }

        const orphanAlerts = await ctx.db.query("alerts").order("asc").take(batchSize)
        for (const alert of orphanAlerts) {
            if (!alert.strategyId || await strategyExists(alert.strategyId)) {
                continue
            }

            await ctx.db.delete(alert._id)
            deleted.alerts++
        }

        return {
            ...deleted,
            hasMore: false,
        }
    },
})

export const triggerManualRun = mutation({
    args: {
        strategyId: v.id("strategies"),
    },
    handler: async (ctx, args) => {
        await requireUser(ctx)
        const strategy = await ctx.db.get(args.strategyId)

        if (!strategy) {
            throw new Error(`Strategy not found: ${args.strategyId}`)
        }

        const existing = await ctx.db
            .query("manual_run_requests")
            .withIndex("by_strategy_terminal", (q) =>
                q.eq("strategyId", args.strategyId).eq("terminalAt", undefined)
            )
            .first()

        if (existing) {
            return existing._id
        }

        return await ctx.db.insert("manual_run_requests", {
            strategyId: args.strategyId,
            app: strategy.app,
            requestedAt: Date.now(),
            attemptCount: 0,
        })
    },
})

type MutableCascadeDeleteCounts = CascadeDeleteCounts

async function deleteRunBatch(
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

async function deleteStrategyTableBatch(
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

    const appStrategies = await ctx.db
        .query("strategies")
        .withIndex("by_app", (q) => q.eq("app", app))
        .take(2)
    const isLastStrategyForApp = appStrategies.length === 1

    if (!isLastStrategyForApp) {
        return false
    }

    const remainingProviderPositions = await ctx.db
        .query("provider_positions")
        .withIndex("by_app", (q) => q.eq("app", app))
        .take(batchSize)

    if (remainingProviderPositions.length > 0) {
        for (const position of remainingProviderPositions) {
            await ctx.db.delete(position._id)
            deleted.providerPositions++
        }
        return true
    }

    const remainingProviderWorkingOrders = await ctx.db
        .query("provider_working_orders")
        .withIndex("by_app", (q) => q.eq("app", app))
        .take(batchSize)

    if (remainingProviderWorkingOrders.length > 0) {
        for (const order of remainingProviderWorkingOrders) {
            await ctx.db.delete(order._id)
            deleted.providerWorkingOrders++
        }
        return true
    }

    const providerSyncState = await ctx.db
        .query("provider_sync_state")
        .withIndex("by_app", (q) => q.eq("app", app))
        .first()

    if (providerSyncState) {
        await ctx.db.delete(providerSyncState._id)
        deleted.providerSyncStates++
        return true
    }

    const snapshots = await ctx.db
        .query("account_snapshots")
        .withIndex("by_app", (q) => q.eq("app", app))
        .take(batchSize)

    if (snapshots.length > 0) {
        for (const snapshot of snapshots) {
            await ctx.db.delete(snapshot._id)
            deleted.accountSnapshots++
        }
        return true
    }

    const heartbeat = await ctx.db
        .query("app_heartbeats")
        .withIndex("by_app", (q) => q.eq("app", app))
        .first()

    if (heartbeat) {
        await ctx.db.delete(heartbeat._id)
        deleted.appHeartbeats++
        return true
    }

    return false
}

async function cascadeDeleteRun(
    ctx: { db: DatabaseWriter },
    runId: Id<"strategy_runs">
): Promise<{
    agentLogs: number
    tradeEvents: number
    orders: number
    orderTransitions: number
}> {
    let agentLogs = 0
    let tradeEvents = 0
    let orders = 0
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
        await ctx.db.delete(order._id)
        orders++
    }

    await ctx.db.delete(runId)

    return {
        agentLogs,
        tradeEvents,
        orders,
        orderTransitions,
    }
}

async function cascadeDeleteStrategy(
    ctx: { db: DatabaseWriter },
    strategyId: Id<"strategies">
): Promise<{
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
}> {
    const strategy = await ctx.db.get(strategyId)

    if (!strategy) {
        throw new Error(`Strategy not found: ${strategyId}`)
    }

    let runs = 0
    let agentLogs = 0
    let tradeEvents = 0
    let orders = 0
    let orderTransitions = 0
    let positions = 0
    let instrumentClaims = 0
    let positionSyncs = 0
    let providerPositions = 0
    let providerWorkingOrders = 0
    let providerSyncStates = 0
    let accountSnapshots = 0
    let appHeartbeats = 0
    let manualRunRequests = 0
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

    const strategyAlerts = (await ctx.db.query("alerts").collect()).filter(
        (alert) => alert.strategyId === strategyId
    )

    for (const alert of strategyAlerts) {
        await ctx.db.delete(alert._id)
        alerts++
    }

    const appStrategies = await ctx.db
        .query("strategies")
        .withIndex("by_app", (q) => q.eq("app", strategy.app))
        .collect()
    const isLastStrategyForApp = appStrategies.length === 1

    if (isLastStrategyForApp) {
        const remainingProviderPositions = await ctx.db
            .query("provider_positions")
            .withIndex("by_app", (q) => q.eq("app", strategy.app))
            .collect()

        for (const position of remainingProviderPositions) {
            await ctx.db.delete(position._id)
            providerPositions++
        }

        const remainingProviderWorkingOrders = await ctx.db
            .query("provider_working_orders")
            .withIndex("by_app", (q) => q.eq("app", strategy.app))
            .collect()

        for (const order of remainingProviderWorkingOrders) {
            await ctx.db.delete(order._id)
            providerWorkingOrders++
        }

        const providerSyncState = await ctx.db
            .query("provider_sync_state")
            .withIndex("by_app", (q) => q.eq("app", strategy.app))
            .first()

        if (providerSyncState) {
            await ctx.db.delete(providerSyncState._id)
            providerSyncStates++
        }

        const snapshots = await ctx.db
            .query("account_snapshots")
            .withIndex("by_app", (q) => q.eq("app", strategy.app))
            .collect()

        for (const snapshot of snapshots) {
            await ctx.db.delete(snapshot._id)
            accountSnapshots++
        }

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
        orderTransitions,
        positions,
        instrumentClaims,
        positionSyncs,
        providerPositions,
        providerWorkingOrders,
        providerSyncStates,
        accountSnapshots,
        appHeartbeats,
        manualRunRequests,
        alerts,
    }
}

export const stopRun = mutation({
    args: { runId: v.id("strategy_runs") },
    handler: async (ctx, args) => {
        await requireUser(ctx)
        const run = await ctx.db.get(args.runId)
        if (!run) throw new Error("Run not found")
        if (run.status !== "running") throw new Error("Run is not active")
        await ctx.db.patch(args.runId, {
            status: "failed",
            error: "Manually stopped by user",
            endedAt: Date.now(),
        })
    },
})

export const deleteRun = mutation({
    args: { runId: v.id("strategy_runs") },
    handler: async (ctx, args) => {
        await requireUser(ctx)
        const run = await ctx.db.get(args.runId)
        if (!run) throw new Error("Run not found")
        await cascadeDeleteRun(ctx, args.runId)
    },
})

export const deleteAllRuns = mutation({
    args: {
        strategyId: v.id("strategies"),
        serviceToken: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        if (args.serviceToken) {
            requireServiceToken(args.serviceToken)
        } else {
            await requireUser(ctx)
        }

        const runs = await ctx.db
            .query("strategy_runs")
            .withIndex("by_strategy", (q) => q.eq("strategyId", args.strategyId))
            .collect()

        for (const run of runs) {
            await cascadeDeleteRun(ctx, run._id)
        }

        return { deleted: runs.length }
    },
})

export const replaceAllStrategies = mutation({
    args: {
        serviceToken: v.string(),
        strategies: v.array(strategyImportArg),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)

        const strategies = args.strategies.map((strategy) => validateStrategyConfig(strategy))
        const existingStrategies = await ctx.db.query("strategies").collect()

        for (const strategy of existingStrategies) {
            await assertStrategyDeletionSafe(ctx, strategy)
        }

        const deleted = {
            strategies: 0,
            runs: 0,
            agentLogs: 0,
            tradeEvents: 0,
            orders: 0,
            orderTransitions: 0,
            positions: 0,
            instrumentClaims: 0,
            positionSyncs: 0,
            providerPositions: 0,
            providerWorkingOrders: 0,
            providerSyncStates: 0,
            accountSnapshots: 0,
            appHeartbeats: 0,
            manualRunRequests: 0,
            alerts: 0,
        }

        const runs = await ctx.db.query("strategy_runs").collect()

        for (const run of runs) {
            const result = await cascadeDeleteRun(ctx, run._id)
            deleted.runs++
            deleted.agentLogs += result.agentLogs
            deleted.tradeEvents += result.tradeEvents
            deleted.orders += result.orders
            deleted.orderTransitions += result.orderTransitions
        }
        for (const strategy of existingStrategies) {
            const result = await cascadeDeleteStrategy(ctx, strategy._id)
            deleted.strategies++
            deleted.runs += result.runs
            deleted.agentLogs += result.agentLogs
            deleted.tradeEvents += result.tradeEvents
            deleted.orders += result.orders
            deleted.orderTransitions += result.orderTransitions
            deleted.positions += result.positions
            deleted.instrumentClaims += result.instrumentClaims
            deleted.positionSyncs += result.positionSyncs
            deleted.providerPositions += result.providerPositions
            deleted.providerWorkingOrders += result.providerWorkingOrders
            deleted.providerSyncStates += result.providerSyncStates
            deleted.accountSnapshots += result.accountSnapshots
            deleted.appHeartbeats += result.appHeartbeats
            deleted.manualRunRequests += result.manualRunRequests
            deleted.alerts += result.alerts
        }

        const now = Date.now()

        for (const strategy of strategies) {
            await ctx.db.insert("strategies", {
                ...strategy,
                createdAt: now,
                updatedAt: now,
            })
        }

        return {
            importedStrategies: strategies.length,
            deleted,
        }
    },
})

async function assertStrategyDeletionSafe(
    ctx: { db: DatabaseWriter },
    strategy: Doc<"strategies">
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
            .withIndex("by_app", (q) => q.eq("app", strategy.app))
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

    const hasLiveProviderExposure = trackedPositions.length > 0 || trackedWorkingOrders.length > 0

    if (
        !isDryRun &&
        hasLiveProviderExposure &&
        providerState &&
        (
            providerState.driftDetected ||
            providerState.providerStatus !== "healthy" ||
            isPortfolioStateStale(providerState.lastVerifiedAt)
        )
    ) {
        throw new Error(
            `Cannot delete strategy while ${strategy.app} provider ownership is stale or drifted. Run the backend-admin reset flow after operator review.`
        )
    }

    if (!isDryRun && (trackedPositions.length > 0 || trackedWorkingOrders.length > 0)) {
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
        return false
    }

    return Date.now() - lastVerifiedAt > PORTFOLIO_STALE_AFTER_MS
}

function sumDeletedCounts(counts: {
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
}): number {
    return (
        counts.runs +
        counts.agentLogs +
        counts.tradeEvents +
        counts.orders +
        counts.orderTransitions +
        counts.positions +
        counts.instrumentClaims +
        counts.positionSyncs +
        counts.providerPositions +
        counts.providerWorkingOrders +
        counts.providerSyncStates +
        counts.accountSnapshots +
        counts.appHeartbeats +
        counts.manualRunRequests +
        counts.alerts
    )
}

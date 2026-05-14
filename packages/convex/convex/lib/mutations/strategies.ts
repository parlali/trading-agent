import { mutation } from "../../_generated/server"
import type { Doc, Id } from "../../_generated/dataModel"
import { v } from "convex/values"
import { validateStrategyConfig } from "@valiq-trading/core"
import { requireUser, requireServiceToken, requireUserOrServiceToken } from "../authGuards"
import { createEmptyCascadeDeleteCounts, type CascadeDeleteCounts } from "../cascadeDelete"
import { incrementControlPlaneMetric } from "../controlPlaneMetrics"
import {
    addCascadeDeleteCounts,
    assertStrategyDeletionSafe,
    cascadeDeleteRun,
    cascadeDeleteStrategy,
    deleteFinalStrategyAppRows,
    createEmptyStrategyDeleteCounts,
    deleteRunBatch,
    deleteStrategyTableBatch,
    sumDeletedCounts,
} from "./strategyCascadeDelete"
import { venueAppV } from "../validators"

const strategyImportArg = v.object({
    app: venueAppV,
    name: v.string(),
    enabled: v.boolean(),
    schedule: v.string(),
    policy: v.any(),
    context: v.string(),
})
export const upsertStrategy = mutation({
    args: {
        id: v.optional(v.id("strategies")),
        app: venueAppV,
        name: v.string(),
        enabled: v.boolean(),
        schedule: v.string(),
        policy: v.any(),
        context: v.string(),
        serviceToken: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        await requireUserOrServiceToken(ctx, args.serviceToken)

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
        await requireUserOrServiceToken(ctx, args.serviceToken)
        await ctx.db.patch(args.strategyId, { enabled: false })
    },
})

export const deleteStrategy = mutation({
    args: {
        strategyId: v.id("strategies"),
        serviceToken: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        await requireUserOrServiceToken(ctx, args.serviceToken)
        const strategy = await ctx.db.get(args.strategyId)
        if (!strategy) {
            throw new Error(`Strategy not found: ${args.strategyId}`)
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
        await requireUserOrServiceToken(ctx, args.serviceToken)

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
        const recordDeletedDocs = async (delta = sumDeletedCounts(deleted)): Promise<void> => {
            await incrementControlPlaneMetric(ctx, {
                metric: "maintenance.delete_strategy_batch.deleted_docs",
                app: strategy.app,
                delta,
            })
        }
        const partialResult = () => ({
            ...deleted,
            strategyDeleted: false,
            hasMore: true,
        })

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
            await recordDeletedDocs()
            return partialResult()
        }

        if (await deleteStrategyTableBatch(ctx, args.strategyId, strategy.app, deleted, batchSize)) {
            await recordDeletedDocs()
            return partialResult()
        }

        await deleteFinalStrategyAppRows(ctx, strategy.app, deleted)
        await ctx.db.delete(args.strategyId)
        await recordDeletedDocs(sumDeletedCounts(deleted) + 1)

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

        const deleted = createEmptyStrategyDeleteCounts()

        const existingStrategies = await ctx.db.query("strategies").collect()

        for (const strategy of existingStrategies) {
            await assertStrategyDeletionSafe(ctx, strategy)
        }

        for (const strategy of existingStrategies) {
            const result = await cascadeDeleteStrategy(ctx, strategy._id)
            deleted.strategies++
            addCascadeDeleteCounts(deleted, result)
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
        const deleted = createEmptyCascadeDeleteCounts()

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

        const orphanRiskStates = await ctx.db.query("strategy_risk_states").order("asc").take(batchSize)
        for (const riskState of orphanRiskStates) {
            if (await strategyExists(riskState.strategyId)) {
                continue
            }

            await ctx.db.delete(riskState._id)
            deleted.strategyRiskStates++
        }

        if (sumDeletedCounts(deleted) > 0) {
            return {
                ...deleted,
                hasMore: true,
            }
        }

        const orphanExecutionFaults = await ctx.db.query("execution_safety_faults").order("asc").take(batchSize)
        for (const fault of orphanExecutionFaults) {
            if (await strategyExists(fault.strategyId)) {
                continue
            }

            await ctx.db.delete(fault._id)
            deleted.executionSafetyFaults++
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
        await requireUserOrServiceToken(ctx, args.serviceToken)

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

        const deleted = createEmptyStrategyDeleteCounts()

        const runs = await ctx.db.query("strategy_runs").collect()

        for (const run of runs) {
            const result = await cascadeDeleteRun(ctx, run._id)
            deleted.runs++
            addCascadeDeleteCounts(deleted, result)
        }
        for (const strategy of existingStrategies) {
            const result = await cascadeDeleteStrategy(ctx, strategy._id)
            deleted.strategies++
            addCascadeDeleteCounts(deleted, result)
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

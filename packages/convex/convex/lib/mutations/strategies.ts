import { mutation } from "../../_generated/server"
import type { DatabaseWriter } from "../../_generated/server"
import type { Id } from "../../_generated/dataModel"
import { v } from "convex/values"
import { requireUser, requireServiceToken } from "../authGuards"

export const upsertStrategy = mutation({
    args: {
        id: v.optional(v.id("strategies")),
        app: v.union(
            v.literal("alpaca-options"),
            v.literal("polymarket"),
            v.literal("mt5"),
            v.literal("binance-futures")
        ),
        name: v.string(),
        enabled: v.boolean(),
        schedule: v.string(),
        policy: v.any(),
        context: v.string(),
    },
    handler: async (ctx, args) => {
        await requireUser(ctx)
        const now = Date.now()
        if (args.id) {
            await ctx.db.patch(args.id, {
                app: args.app,
                name: args.name,
                enabled: args.enabled,
                schedule: args.schedule,
                policy: args.policy,
                context: args.context,
                updatedAt: now,
            })
            return args.id
        }
        return await ctx.db.insert("strategies", {
            app: args.app,
            name: args.name,
            enabled: args.enabled,
            schedule: args.schedule,
            policy: args.policy,
            context: args.context,
            createdAt: now,
            updatedAt: now,
        })
    },
})

export const disableStrategy = mutation({
    args: { strategyId: v.id("strategies") },
    handler: async (ctx, args) => {
        await requireUser(ctx)
        await ctx.db.patch(args.strategyId, { enabled: false })
    },
})

export const deleteStrategy = mutation({
    args: { strategyId: v.id("strategies") },
    handler: async (ctx, args) => {
        await requireUser(ctx)
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

        await ctx.db.delete(args.strategyId)
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
            .withIndex("by_strategy", (q) => q.eq("strategyId", args.strategyId))
            .first()

        if (existing) {
            return existing._id
        }

        return await ctx.db.insert("manual_run_requests", {
            strategyId: args.strategyId,
            app: strategy.app,
            requestedAt: Date.now(),
        })
    },
})

async function cascadeDeleteRun(
    ctx: { db: DatabaseWriter },
    runId: Id<"strategy_runs">
): Promise<void> {
    const logs = await ctx.db
        .query("agent_logs")
        .withIndex("by_run", (q) => q.eq("runId", runId))
        .collect()
    for (const log of logs) await ctx.db.delete(log._id)

    const events = await ctx.db
        .query("trade_events")
        .withIndex("by_run", (q) => q.eq("runId", runId))
        .collect()
    for (const event of events) await ctx.db.delete(event._id)

    const orders = await ctx.db
        .query("orders")
        .withIndex("by_run", (q) => q.eq("runId", runId))
        .collect()
    for (const order of orders) {
        const transitions = await ctx.db
            .query("order_transitions")
            .withIndex("by_order_sequence", (q) => q.eq("orderId", order.orderId))
            .collect()
        for (const t of transitions) await ctx.db.delete(t._id)
        await ctx.db.delete(order._id)
    }

    await ctx.db.delete(runId)
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

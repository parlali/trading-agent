import { query } from "./_generated/server"
import { v } from "convex/values"

// Return all enabled strategies for a given app
export const getStrategyConfigs = query({
    args: {
        app: v.union(
            v.literal("alpaca-options"),
            v.literal("polymarket"),
            v.literal("mt5")
        ),
    },
    handler: async (ctx, args) => {
        return await ctx.db
            .query("strategies")
            .withIndex("by_app_enabled", (q) =>
                q.eq("app", args.app).eq("enabled", true)
            )
            .collect()
    },
})

// Return a single strategy config by ID
export const getStrategyById = query({
    args: { id: v.id("strategies") },
    handler: async (ctx, args) => {
        return await ctx.db.get(args.id)
    },
})

// Return recent runs for a strategy, ordered by most recent first
export const getRunHistory = query({
    args: {
        strategyId: v.id("strategies"),
        limit: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
        const limit = args.limit ?? 20
        return await ctx.db
            .query("strategy_runs")
            .withIndex("by_strategy", (q) => q.eq("strategyId", args.strategyId))
            .order("desc")
            .take(limit)
    },
})

// Return the currently running run for a strategy, if any
export const getActiveRun = query({
    args: { strategyId: v.id("strategies") },
    handler: async (ctx, args) => {
        return await ctx.db
            .query("strategy_runs")
            .withIndex("by_strategy_status", (q) =>
                q.eq("strategyId", args.strategyId).eq("status", "running")
            )
            .first()
    },
})

// Return latest position snapshot for a strategy
export const getOpenPositions = query({
    args: { strategyId: v.id("strategies") },
    handler: async (ctx, args) => {
        const snapshots = await ctx.db
            .query("positions")
            .withIndex("by_strategy_synced_at", (q) => q.eq("strategyId", args.strategyId))
            .order("desc")
            .collect()

        const latestSyncedAt = snapshots[0]?.syncedAt
        if (latestSyncedAt === undefined) {
            return []
        }

        return snapshots.filter((position) => position.syncedAt === latestSyncedAt)
    },
})

// Return all trade events for a run
export const getTradeEvents = query({
    args: { runId: v.id("strategy_runs") },
    handler: async (ctx, args) => {
        return await ctx.db
            .query("trade_events")
            .withIndex("by_run", (q) => q.eq("runId", args.runId))
            .collect()
    },
})

export const getOrderById = query({
    args: { orderId: v.string() },
    handler: async (ctx, args) => {
        return await ctx.db
            .query("orders")
            .withIndex("by_order_id", (q) => q.eq("orderId", args.orderId))
            .first()
    },
})

export const getActiveOrders = query({
    args: { strategyId: v.id("strategies") },
    handler: async (ctx, args) => {
        const pending = await ctx.db
            .query("orders")
            .withIndex("by_strategy_status", (q) =>
                q.eq("strategyId", args.strategyId).eq("status", "pending")
            )
            .collect()

        const partiallyFilled = await ctx.db
            .query("orders")
            .withIndex("by_strategy_status", (q) =>
                q.eq("strategyId", args.strategyId).eq("status", "partially_filled")
            )
            .collect()

        return [...pending, ...partiallyFilled].sort((left, right) => right.updatedAt - left.updatedAt)
    },
})

export const getOrderTransitions = query({
    args: { orderId: v.string() },
    handler: async (ctx, args) => {
        return await ctx.db
            .query("order_transitions")
            .withIndex("by_order_sequence", (q) => q.eq("orderId", args.orderId))
            .collect()
    },
})

// Return full agent reasoning trace for a run, ordered by sequence
export const getAgentLogs = query({
    args: { runId: v.id("strategy_runs") },
    handler: async (ctx, args) => {
        return await ctx.db
            .query("agent_logs")
            .withIndex("by_run_sequence", (q) => q.eq("runId", args.runId))
            .collect()
    },
})

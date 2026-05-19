import { query } from "../../_generated/server"
import type { Doc } from "../../_generated/dataModel"
import { v } from "convex/values"
import { requireUser, requireUserOrServiceToken } from "../authGuards"
import { findOrderRowByIdentity } from "../orderIdentityLookup"

export const getOrderById = query({
    args: { serviceToken: v.optional(v.string()), orderId: v.string() },
    handler: async (ctx, args) => {
        await requireUserOrServiceToken(ctx, args.serviceToken)
        return await findOrderRowByIdentity(ctx.db, args.orderId)
    },
})

export const getActiveOrders = query({
    args: { serviceToken: v.optional(v.string()), strategyId: v.id("strategies") },
    handler: async (ctx, args) => {
        await requireUserOrServiceToken(ctx, args.serviceToken)
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
        await requireUser(ctx)
        return await ctx.db
            .query("order_transitions")
            .withIndex("by_order_sequence", (q) => q.eq("orderId", args.orderId))
            .collect()
    },
})

export const getTradeEvents = query({
    args: { runId: v.id("strategy_runs") },
    handler: async (ctx, args) => {
        await requireUser(ctx)
        return await ctx.db
            .query("trade_events")
            .withIndex("by_run", (q) => q.eq("runId", args.runId))
            .collect()
    },
})

export const getTradeHistory = query({
    args: {
        serviceToken: v.optional(v.string()),
        app: v.optional(
            v.union(
                v.literal("alpaca-options"),
                v.literal("polymarket"),
                v.literal("mt5"),
                v.literal("okx-swap")
            )
        ),
        strategyId: v.optional(v.id("strategies")),
        runId: v.optional(v.id("strategy_runs")),
        eventTypes: v.optional(
            v.array(
                v.union(
                    v.literal("intent"),
                    v.literal("validation"),
                    v.literal("submission"),
                    v.literal("fill_update"),
                    v.literal("filled"),
                    v.literal("rejected"),
                    v.literal("cancelled")
                )
            )
        ),
        limit: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
        await requireUserOrServiceToken(ctx, args.serviceToken)
        const limit = args.limit ?? 100

        let events: Doc<"trade_events">[]

        if (args.runId) {
            events = await ctx.db
                .query("trade_events")
                .withIndex("by_run", (q) => q.eq("runId", args.runId!))
                .collect()
        } else if (args.strategyId) {
            events = await ctx.db
                .query("trade_events")
                .withIndex("by_strategy", (q) => q.eq("strategyId", args.strategyId!))
                .collect()
        } else if (args.app) {
            const appStrategies = await ctx.db
                .query("strategies")
                .withIndex("by_app", (q) => q.eq("app", args.app!))
                .collect()
            const perStrategy = await Promise.all(
                appStrategies.map((strategy) =>
                    ctx.db
                        .query("trade_events")
                        .withIndex("by_strategy", (q) => q.eq("strategyId", strategy._id))
                        .collect()
                )
            )
            events = perStrategy.flat()
        } else {
            events = await ctx.db
                .query("trade_events")
                .order("desc")
                .take(limit)
        }

        return events
            .filter((event) => {
                if (args.strategyId && event.strategyId !== args.strategyId) {
                    return false
                }
                if (args.runId && event.runId !== args.runId) {
                    return false
                }
                if (args.eventTypes && !args.eventTypes.includes(event.eventType)) {
                    return false
                }
                return true
            })
            .sort((left, right) => right.timestamp - left.timestamp)
            .slice(0, limit)
    },
})

export const getStrategyOrderHistory = query({
    args: {
        serviceToken: v.optional(v.string()),
        strategyId: v.id("strategies"),
        limit: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
        await requireUserOrServiceToken(ctx, args.serviceToken)

        const limit = Math.max(1, Math.min(args.limit ?? 200, 500))
        const statuses = [
            "filled",
            "partially_filled",
            "rejected",
            "cancelled",
            "expired",
            "timed_out",
        ] as const

        const rows = (
            await Promise.all(
                statuses.map(async (status) => await ctx.db
                    .query("orders")
                    .withIndex("by_strategy_status", (q) =>
                        q.eq("strategyId", args.strategyId).eq("status", status)
                    )
                    .collect())
            )
        ).flat()

        return rows
            .sort((left, right) => right.updatedAt - left.updatedAt)
            .slice(0, limit)
    },
})

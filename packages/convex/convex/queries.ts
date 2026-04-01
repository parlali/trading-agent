import { query } from "./_generated/server"
import type { Doc } from "./_generated/dataModel"
import { v } from "convex/values"
import { requireUser, requireServiceToken, requireUserOrServiceToken } from "./lib/authGuards"
import {
    getLatestPositionsForStrategy,
    getOwnedInstrumentsByApp,
    getOwnedInstrumentsForStrategy,
} from "./lib/instrumentClaims"

const venueApps = [
    "alpaca-options",
    "polymarket",
    "mt5",
] as const

function isNonNullable<T>(value: T): value is NonNullable<T> {
    return value !== null && value !== undefined
}

// Return all enabled strategies for a given app
export const getStrategyConfigs = query({
    args: {
        serviceToken: v.string(),
        app: v.union(
            v.literal("alpaca-options"),
            v.literal("polymarket"),
            v.literal("mt5")
        ),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
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
    args: { serviceToken: v.optional(v.string()), id: v.id("strategies") },
    handler: async (ctx, args) => {
        await requireUserOrServiceToken(ctx, args.serviceToken)
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
        await requireUser(ctx)
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
        await requireUser(ctx)
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
        await requireUser(ctx)
        return await getLatestPositionsForStrategy(ctx, args.strategyId)
    },
})

// Return all trade events for a run
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

export const getOrderById = query({
    args: { serviceToken: v.optional(v.string()), orderId: v.string() },
    handler: async (ctx, args) => {
        await requireUserOrServiceToken(ctx, args.serviceToken)
        return await ctx.db
            .query("orders")
            .withIndex("by_order_id", (q) => q.eq("orderId", args.orderId))
            .first()
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

// Return full agent reasoning trace for a run, ordered by sequence
export const getAgentLogs = query({
    args: { runId: v.id("strategy_runs") },
    handler: async (ctx, args) => {
        await requireUser(ctx)
        return await ctx.db
            .query("agent_logs")
            .withIndex("by_run_sequence", (q) => q.eq("runId", args.runId))
            .collect()
    },
})

// Return current kill switch state
export const getSystemState = query({
    args: { serviceToken: v.optional(v.string()) },
    handler: async (ctx, args) => {
        await requireUserOrServiceToken(ctx, args.serviceToken)
        const state = await ctx.db
            .query("system_state")
            .withIndex("by_key", (q) => q.eq("key", "kill_switches"))
            .first()

        if (!state) {
            return {
                globalKillSwitch: false,
                appKillSwitches: {
                    alpaca_options: false,
                    polymarket: false,
                    mt5: false,
                },
                updatedAt: 0,
            }
        }

        return {
            globalKillSwitch: state.globalKillSwitch,
            appKillSwitches: state.appKillSwitches,
            updatedAt: state.updatedAt,
        }
    },
})

// Return heartbeat status for all apps
export const getAppHealth = query({
    args: {},
    handler: async (ctx) => {
        await requireUser(ctx)
        return await ctx.db.query("app_heartbeats").collect()
    },
})

// Return latest account snapshot per app
export const getAccountSnapshots = query({
    args: {},
    handler: async (ctx) => {
        await requireUser(ctx)
        const snapshots = await Promise.all(
            venueApps.map((app) =>
                ctx.db
                    .query("account_snapshots")
                    .withIndex("by_app_timestamp", (q) => q.eq("app", app))
                    .order("desc")
                    .first()
            )
        )
        return snapshots.filter(isNonNullable)
    },
})

export const getManualRunRequests = query({
    args: {
        serviceToken: v.string(),
        app: v.union(
            v.literal("alpaca-options"),
            v.literal("polymarket"),
            v.literal("mt5")
        ),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        return await ctx.db
            .query("manual_run_requests")
            .withIndex("by_app", (q) => q.eq("app", args.app))
            .order("desc")
            .collect()
    },
})

export const getDashboardOverview = query({
    args: {},
    handler: async (ctx) => {
        await requireUser(ctx)
        const [
            systemState,
            appHealth,
            strategies,
            runs,
            alerts,
        ] = await Promise.all([
            ctx.db
                .query("system_state")
                .withIndex("by_key", (q) => q.eq("key", "kill_switches"))
                .first(),
            ctx.db.query("app_heartbeats").collect(),
            ctx.db.query("strategies").collect(),
            ctx.db.query("strategy_runs").order("desc").take(50),
            ctx.db.query("alerts").order("desc").take(20),
        ])

        const [accountSnapshots, openPositionsByStrategy] = await Promise.all([
            Promise.all(
                venueApps.map((app) =>
                    ctx.db
                        .query("account_snapshots")
                        .withIndex("by_app_timestamp", (q) => q.eq("app", app))
                        .order("desc")
                        .first()
                )
            ),
            Promise.all(
                strategies.map(async (strategy) => {
                    const positions = await getLatestPositionsForStrategy(ctx, strategy._id)
                    return positions.map((position) => ({ ...position, strategy }))
                })
            ),
        ])

        const latestRunByStrategy = new Map<string, typeof runs[number]>()
        for (const run of runs) {
            const strategyId = String(run.strategyId)
            if (!latestRunByStrategy.has(strategyId)) {
                latestRunByStrategy.set(strategyId, run)
            }
        }

        return {
            systemState: systemState ?? {
                globalKillSwitch: false,
                appKillSwitches: {
                    alpaca_options: false,
                    polymarket: false,
                    mt5: false,
                },
                updatedAt: 0,
            },
            appHealth,
            accountSnapshots: accountSnapshots.filter(isNonNullable),
            activeRuns: runs.filter((run) => run.status === "running"),
            recentRuns: runs.slice(0, 10),
            recentAlerts: alerts,
            openPositions: openPositionsByStrategy.flat(),
            strategies: strategies.map((strategy) => ({
                ...strategy,
                latestRun: latestRunByStrategy.get(String(strategy._id)) ?? null,
            })),
        }
    },
})

export const getTradeHistory = query({
    args: {
        app: v.optional(
            v.union(
                v.literal("alpaca-options"),
                v.literal("polymarket"),
                v.literal("mt5")
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
        await requireUser(ctx)
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

export const getPnlSummary = query({
    args: {
        timeRange: v.union(
            v.literal("24h"),
            v.literal("7d"),
            v.literal("30d")
        ),
    },
    handler: async (ctx, args) => {
        await requireUser(ctx)
        const durationMsByRange = {
            "24h": 24 * 60 * 60 * 1000,
            "7d": 7 * 24 * 60 * 60 * 1000,
            "30d": 30 * 24 * 60 * 60 * 1000,
        } as const
        const end = Date.now()
        const start = end - durationMsByRange[args.timeRange]
        const snapshotsByApp = await Promise.all(
            venueApps.map((app) =>
                ctx.db
                    .query("account_snapshots")
                    .withIndex("by_app_timestamp", (q) => q.eq("app", app).gte("timestamp", start))
                    .order("asc")
                    .collect()
            )
        )
        const filteredSnapshots = snapshotsByApp.flat()

        const pointsByApp = new Map<string, typeof filteredSnapshots>()
        for (const snapshot of filteredSnapshots) {
            const existing = pointsByApp.get(snapshot.app) ?? []
            existing.push(snapshot)
            pointsByApp.set(snapshot.app, existing)
        }

        const apps = venueApps.map((app) => {
            const points = pointsByApp.get(app) ?? []
            const first = points[0] ?? null
            const latest = points[points.length - 1] ?? null
            const change = first && latest
                ? (latest.balance + latest.openPnl) - (first.balance + first.openPnl)
                : 0

            return {
                app,
                points,
                latest,
                change,
            }
        })

        return {
            timeRange: args.timeRange,
            start,
            end,
            apps,
            aggregate: {
                latestNetLiq: apps.reduce((total, item) => {
                    if (!item.latest) {
                        return total
                    }

                    return total + item.latest.balance + item.latest.openPnl
                }, 0),
                periodChange: apps.reduce((total, item) => total + item.change, 0),
            },
        }
    },
})

export const getEquityTimeSeries = query({
    args: {
        timeRange: v.union(
            v.literal("24h"),
            v.literal("7d"),
            v.literal("30d"),
            v.literal("90d"),
            v.literal("all")
        ),
    },
    handler: async (ctx, args) => {
        await requireUser(ctx)
        const durationMsByRange = {
            "24h": 24 * 60 * 60 * 1000,
            "7d": 7 * 24 * 60 * 60 * 1000,
            "30d": 30 * 24 * 60 * 60 * 1000,
            "90d": 90 * 24 * 60 * 60 * 1000,
            "all": Infinity,
        } as const

        const end = Date.now()
        const start = args.timeRange === "all" ? 0 : end - durationMsByRange[args.timeRange]

        const snapshotsByApp = await Promise.all(
            venueApps.map((app) =>
                ctx.db
                    .query("account_snapshots")
                    .withIndex("by_app_timestamp", (q) => q.eq("app", app).gte("timestamp", start))
                    .order("asc")
                    .collect()
            )
        )

        return snapshotsByApp
            .flat()
            .sort((a, b) => a.timestamp - b.timestamp)
            .map((s) => ({
                app: s.app,
                timestamp: s.timestamp,
                equity: s.balance + s.openPnl,
                balance: s.balance,
                openPnl: s.openPnl,
            }))
    },
})

export const getAllStrategies = query({
    args: {},
    handler: async (ctx) => {
        await requireUser(ctx)
        return await ctx.db.query("strategies").collect()
    },
})

export const getStrategyOwnedInstruments = query({
    args: { serviceToken: v.string(), strategyId: v.id("strategies") },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        return await getOwnedInstrumentsForStrategy(ctx, args.strategyId)
    },
})

export const getAllOwnedInstrumentsByApp = query({
    args: {
        serviceToken: v.string(),
        app: v.union(
            v.literal("alpaca-options"),
            v.literal("polymarket"),
            v.literal("mt5")
        ),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        return await getOwnedInstrumentsByApp(ctx, args.app)
    },
})

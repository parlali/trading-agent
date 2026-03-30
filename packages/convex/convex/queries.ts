import { query } from "./_generated/server"
import { v } from "convex/values"

const venueApps = [
    "alpaca-options",
    "polymarket",
    "mt5",
] as const

type VenueApp = typeof venueApps[number]

function getLatestSyncedAtByStrategy(
    syncs: Array<{
        strategyId: unknown
        syncedAt: number
    }>
): Map<string, number> {
    const latestSyncedAtByStrategy = new Map<string, number>()

    for (const sync of syncs) {
        const strategyId = String(sync.strategyId)
        const currentLatest = latestSyncedAtByStrategy.get(strategyId) ?? 0

        if (sync.syncedAt > currentLatest) {
            latestSyncedAtByStrategy.set(strategyId, sync.syncedAt)
        }
    }

    return latestSyncedAtByStrategy
}

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
        const latestSync = await ctx.db
            .query("position_syncs")
            .withIndex("by_strategy_synced_at", (q) => q.eq("strategyId", args.strategyId))
            .order("desc")
            .first()

        if (!latestSync || latestSync.positionCount === 0) {
            return []
        }

        const snapshots = await ctx.db
            .query("positions")
            .withIndex("by_strategy_synced_at", (q) => q.eq("strategyId", args.strategyId))
            .collect()

        const latestSyncedAt = latestSync.syncedAt
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

// Return current kill switch state
export const getSystemState = query({
    args: {},
    handler: async (ctx) => {
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
        return await ctx.db.query("app_heartbeats").collect()
    },
})

// Return latest account snapshot per app
export const getAccountSnapshots = query({
    args: {},
    handler: async (ctx) => {
        const allSnapshots = await ctx.db
            .query("account_snapshots")
            .order("desc")
            .collect()

        const latestByApp = new Map<string, typeof allSnapshots[number]>()
        for (const snapshot of allSnapshots) {
            if (!latestByApp.has(snapshot.app)) {
                latestByApp.set(snapshot.app, snapshot)
            }
        }

        return Array.from(latestByApp.values())
    },
})

export const getManualRunRequests = query({
    args: {
        app: v.union(
            v.literal("alpaca-options"),
            v.literal("polymarket"),
            v.literal("mt5")
        ),
    },
    handler: async (ctx, args) => {
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
        const [
            systemState,
            appHealth,
            strategies,
            runs,
            alerts,
            accountSnapshots,
            positionSyncs,
            positions,
        ] = await Promise.all([
            ctx.db
                .query("system_state")
                .withIndex("by_key", (q) => q.eq("key", "kill_switches"))
                .first(),
            ctx.db.query("app_heartbeats").collect(),
            ctx.db.query("strategies").collect(),
            ctx.db.query("strategy_runs").order("desc").take(50),
            ctx.db.query("alerts").order("desc").take(20),
            ctx.db.query("account_snapshots").order("desc").collect(),
            ctx.db.query("position_syncs").collect(),
            ctx.db.query("positions").collect(),
        ])

        const latestAccountByApp = new Map<string, typeof accountSnapshots[number]>()
        for (const snapshot of accountSnapshots) {
            if (!latestAccountByApp.has(snapshot.app)) {
                latestAccountByApp.set(snapshot.app, snapshot)
            }
        }

        const latestRunByStrategy = new Map<string, typeof runs[number]>()
        for (const run of runs) {
            const strategyId = String(run.strategyId)
            if (!latestRunByStrategy.has(strategyId)) {
                latestRunByStrategy.set(strategyId, run)
            }
        }

        const latestSyncedAtByStrategy = getLatestSyncedAtByStrategy(positionSyncs)
        const strategiesById = new Map(strategies.map((strategy) => [String(strategy._id), strategy]))

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
            accountSnapshots: Array.from(latestAccountByApp.values()),
            activeRuns: runs.filter((run) => run.status === "running"),
            recentRuns: runs.slice(0, 10),
            recentAlerts: alerts,
            openPositions: positions
                .filter((position) =>
                    latestSyncedAtByStrategy.get(String(position.strategyId)) === position.syncedAt
                )
                .map((position) => ({
                    ...position,
                    strategy: strategiesById.get(String(position.strategyId)) ?? null,
                })),
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
        const limit = args.limit ?? 100
        const appStrategies = args.app
            ? await ctx.db
                .query("strategies")
                .withIndex("by_app", (q) => q.eq("app", args.app!))
                .collect()
            : []

        const allowedStrategyIds = args.app
            ? new Set(appStrategies.map((strategy) => String(strategy._id)))
            : null

        const events = await ctx.db.query("trade_events").collect()

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

                if (allowedStrategyIds && !allowedStrategyIds.has(String(event.strategyId))) {
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
        const durationMsByRange = {
            "24h": 24 * 60 * 60 * 1000,
            "7d": 7 * 24 * 60 * 60 * 1000,
            "30d": 30 * 24 * 60 * 60 * 1000,
        } as const
        const end = Date.now()
        const start = end - durationMsByRange[args.timeRange]
        const snapshots = await ctx.db.query("account_snapshots").collect()

        const filteredSnapshots = snapshots
            .filter((snapshot) => {
                return venueApps.includes(snapshot.app as VenueApp) &&
                    snapshot.timestamp >= start &&
                    snapshot.timestamp <= end
            })
            .sort((left, right) => left.timestamp - right.timestamp)

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
        const durationMsByRange = {
            "24h": 24 * 60 * 60 * 1000,
            "7d": 7 * 24 * 60 * 60 * 1000,
            "30d": 30 * 24 * 60 * 60 * 1000,
            "90d": 90 * 24 * 60 * 60 * 1000,
            "all": Infinity,
        } as const

        const end = Date.now()
        const start = args.timeRange === "all" ? 0 : end - durationMsByRange[args.timeRange]

        const snapshots = await ctx.db.query("account_snapshots").collect()

        return snapshots
            .filter((s) =>
                venueApps.includes(s.app as VenueApp) &&
                s.timestamp >= start &&
                s.timestamp <= end
            )
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
        return await ctx.db.query("strategies").collect()
    },
})

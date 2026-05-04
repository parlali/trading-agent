import { query } from "../../_generated/server"
import { v } from "convex/values"
import { VENUE_APPS } from "@valiq-trading/core"
import { requireUser } from "../authGuards"
import { getLatestPositionsForStrategy } from "../instrumentClaims"
import { isDryRunLedgerMetadata } from "../dryRunLedger"
import { createDefaultKillSwitchState } from "../killSwitchState"

function isNonNullable<T>(value: T): value is NonNullable<T> {
    return value !== null && value !== undefined
}

function resolveSnapshotEquity(snapshot: { balance: number; openPnl: number; equity?: number }): number {
    return snapshot.equity ?? (snapshot.balance + snapshot.openPnl)
}

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
                VENUE_APPS.map((app) =>
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
                    return positions
                        .filter((position) => !isDryRunLedgerMetadata(position.metadata))
                        .map((position) => ({ ...position, strategy }))
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
            systemState: systemState ?? createDefaultKillSwitchState(),
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
            VENUE_APPS.map((app) =>
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

        const apps = VENUE_APPS.map((app) => {
            const points = pointsByApp.get(app) ?? []
            const first = points[0] ?? null
            const latest = points[points.length - 1] ?? null
            const change = first && latest
                ? resolveSnapshotEquity(latest) - resolveSnapshotEquity(first)
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

                    return total + resolveSnapshotEquity(item.latest)
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
            VENUE_APPS.map((app) =>
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
                equity: resolveSnapshotEquity(s),
                balance: s.balance,
                openPnl: s.openPnl,
            }))
    },
})

export const getAccountSnapshots = query({
    args: {},
    handler: async (ctx) => {
        await requireUser(ctx)
        const snapshots = await Promise.all(
            VENUE_APPS.map((app) =>
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

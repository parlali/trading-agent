import { mutation } from "../../_generated/server"
import { v } from "convex/values"
import { requireUser, requireServiceToken } from "../authGuards"
import { appV } from "../validators"
import type { App } from "@valiq-trading/core"

export const createAlert = mutation({
    args: {
        serviceToken: v.string(),
        strategyId: v.optional(v.id("strategies")),
        app: v.optional(
            v.union(
                v.literal("alpaca-options"),
                v.literal("polymarket"),
                v.literal("mt5"),
                v.literal("binance-futures"),
                v.literal("backend")
            )
        ),
        severity: v.union(
            v.literal("critical"),
            v.literal("warning"),
            v.literal("info")
        ),
        message: v.string(),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        await ctx.db.insert("alerts", {
            strategyId: args.strategyId,
            app: args.app,
            severity: args.severity,
            message: args.message,
            acknowledged: false,
            timestamp: Date.now(),
        })
    },
})

export const acknowledgeAlert = mutation({
    args: {
        alertId: v.id("alerts"),
    },
    handler: async (ctx, args) => {
        await requireUser(ctx)
        await ctx.db.patch(args.alertId, {
            acknowledged: true,
        })
    },
})

export const reportHeartbeat = mutation({
    args: {
        serviceToken: v.string(),
        app: v.union(
            v.literal("alpaca-options"),
            v.literal("polymarket"),
            v.literal("mt5"),
            v.literal("binance-futures"),
            v.literal("backend")
        ),
        status: v.union(
            v.literal("healthy"),
            v.literal("degraded"),
            v.literal("unhealthy")
        ),
        metadata: v.optional(v.any()),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        const existing = await ctx.db
            .query("app_heartbeats")
            .withIndex("by_app", (q) => q.eq("app", args.app))
            .first()

        const payload = {
            app: args.app,
            status: args.status,
            lastHeartbeat: Date.now(),
            metadata: args.metadata,
        }

        if (existing) {
            await ctx.db.patch(existing._id, payload)
            return existing._id
        }

        return await ctx.db.insert("app_heartbeats", payload)
    },
})

export const snapshotAccountState = mutation({
    args: {
        serviceToken: v.string(),
        app: v.union(
            v.literal("alpaca-options"),
            v.literal("polymarket"),
            v.literal("mt5"),
            v.literal("binance-futures"),
            v.literal("backend")
        ),
        venue: v.string(),
        balance: v.number(),
        equity: v.optional(v.number()),
        buyingPower: v.number(),
        marginUsed: v.number(),
        marginAvailable: v.number(),
        openPnl: v.number(),
        dayPnl: v.number(),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        return await ctx.db.insert("account_snapshots", {
            app: args.app,
            venue: args.venue,
            balance: args.balance,
            equity: args.equity,
            buyingPower: args.buyingPower,
            marginUsed: args.marginUsed,
            marginAvailable: args.marginAvailable,
            openPnl: args.openPnl,
            dayPnl: args.dayPnl,
            timestamp: Date.now(),
        })
    },
})

export const setKillSwitch = mutation({
    args: {
        scope: v.union(
            v.literal("global"),
            v.literal("alpaca-options"),
            v.literal("polymarket"),
            v.literal("mt5"),
            v.literal("binance-futures")
        ),
        enabled: v.boolean(),
        updatedBy: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        await requireUser(ctx)
        const existing = await ctx.db
            .query("system_state")
            .withIndex("by_key", (q) => q.eq("key", "kill_switches"))
            .first()

        const now = Date.now()

        if (!existing) {
            const state = {
                key: "kill_switches" as const,
                globalKillSwitch: args.scope === "global" ? args.enabled : false,
                appKillSwitches: {
                    alpaca_options: args.scope === "alpaca-options" ? args.enabled : false,
                    polymarket: args.scope === "polymarket" ? args.enabled : false,
                    mt5: args.scope === "mt5" ? args.enabled : false,
                    binance_futures: args.scope === "binance-futures" ? args.enabled : false,
                },
                updatedAt: now,
                updatedBy: args.updatedBy,
            }
            return await ctx.db.insert("system_state", state)
        }

        if (args.scope === "global") {
            await ctx.db.patch(existing._id, {
                globalKillSwitch: args.enabled,
                updatedAt: now,
                updatedBy: args.updatedBy,
            })
        } else {
            const killSwitchKey = args.scope.replace(/-/g, "_") as keyof typeof existing.appKillSwitches
            await ctx.db.patch(existing._id, {
                appKillSwitches: {
                    ...existing.appKillSwitches,
                    [killSwitchKey]: args.enabled,
                },
                updatedAt: now,
                updatedBy: args.updatedBy,
            })
        }

        return existing._id
    },
})

export const clearManualRunRequest = mutation({
    args: {
        serviceToken: v.string(),
        requestId: v.id("manual_run_requests"),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        await ctx.db.delete(args.requestId)
    },
})

export const clearFullResetState = mutation({
    args: {
        serviceToken: v.string(),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)

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

        const providerSyncStates = await ctx.db.query("provider_sync_state").collect()
        for (const state of providerSyncStates) {
            await ctx.db.delete(state._id)
            deleted.providerSyncStates++
        }

        const snapshots = await ctx.db.query("account_snapshots").collect()
        for (const snapshot of snapshots) {
            await ctx.db.delete(snapshot._id)
            deleted.accountSnapshots++
        }

        const heartbeats = await ctx.db.query("app_heartbeats").collect()
        for (const heartbeat of heartbeats) {
            await ctx.db.delete(heartbeat._id)
            deleted.appHeartbeats++
        }

        const alerts = await ctx.db.query("alerts").collect()
        for (const alert of alerts) {
            await ctx.db.delete(alert._id)
            deleted.alerts++
        }

        return deleted
    },
})

export const clearFullResetStateBatch = mutation({
    args: {
        serviceToken: v.string(),
        batchSize: v.optional(v.number()),
        preserveApps: v.optional(v.array(appV)),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)

        const batchSize = Math.max(1, Math.min(args.batchSize ?? 20, 50))
        const preserveApps = new Set<App>(args.preserveApps ?? [])
        const deleted = createEmptyCascadeDeleteCounts()
        const venueApps = [
            "alpaca-options",
            "polymarket",
            "mt5",
            "binance-futures",
        ] as const
        const apps = [
            ...venueApps,
            "backend",
        ] as const

        for (const app of venueApps) {
            if (preserveApps.has(app)) {
                continue
            }

            const providerSyncState = await ctx.db
                .query("provider_sync_state")
                .withIndex("by_app", (q) => q.eq("app", app))
                .first()

            if (providerSyncState) {
                await ctx.db.delete(providerSyncState._id)
                deleted.providerSyncStates++
                return {
                    ...deleted,
                    hasMore: true,
                }
            }
        }

        for (const app of apps) {
            if (preserveApps.has(app)) {
                continue
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

                return {
                    ...deleted,
                    hasMore: true,
                }
            }
        }

        for (const app of apps) {
            if (preserveApps.has(app)) {
                continue
            }

            const heartbeat = await ctx.db
                .query("app_heartbeats")
                .withIndex("by_app", (q) => q.eq("app", app))
                .first()

            if (heartbeat) {
                await ctx.db.delete(heartbeat._id)
                deleted.appHeartbeats++
                return {
                    ...deleted,
                    hasMore: true,
                }
            }
        }

        if (preserveApps.size === 0) {
            const alerts = await ctx.db.query("alerts").order("asc").take(batchSize)

            if (alerts.length > 0) {
                for (const alert of alerts) {
                    await ctx.db.delete(alert._id)
                    deleted.alerts++
                }

                return {
                    ...deleted,
                    hasMore: true,
                }
            }
        }

        return {
            ...deleted,
            hasMore: false,
        }
    },
})

function createEmptyCascadeDeleteCounts(): {
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
} {
    return {
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
}

import { query } from "../../_generated/server"
import type { Doc } from "../../_generated/dataModel"
import { v } from "convex/values"
import { requireUser, requireServiceToken, requireUserOrServiceToken } from "../authGuards"
import { createDefaultKillSwitchState } from "../killSwitchState"
import { severityV, venueAppV } from "../validators"

export const getSystemState = query({
    args: { serviceToken: v.optional(v.string()) },
    handler: async (ctx, args) => {
        await requireUserOrServiceToken(ctx, args.serviceToken)
        const state = await ctx.db
            .query("system_state")
            .withIndex("by_key", (q) => q.eq("key", "kill_switches"))
            .first()

        if (!state) {
            return createDefaultKillSwitchState()
        }

        return {
            globalKillSwitch: state.globalKillSwitch,
            appKillSwitches: state.appKillSwitches,
            updatedAt: state.updatedAt,
        }
    },
})

export const getAppHealth = query({
    args: {},
    handler: async (ctx) => {
        await requireUser(ctx)
        return await ctx.db.query("app_heartbeats").collect()
    },
})

export const assertDashboardUser = query({
    args: {},
    handler: async (ctx) => {
        await requireUser(ctx)
        return {
            ok: true,
        }
    },
})

export const getManualRunRequests = query({
    args: {
        serviceToken: v.string(),
        app: venueAppV,
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        return await ctx.db
            .query("manual_run_requests")
            .withIndex("by_app_terminal_requested_at", (q) =>
                q.eq("app", args.app).eq("terminalAt", undefined)
            )
            .order("asc")
            .collect()
    },
})

export const getControlPlaneMetrics = query({
    args: {
        serviceToken: v.string(),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        return await ctx.db.query("control_plane_metrics").collect()
    },
})

export const getRecentAlerts = query({
    args: {
        serviceToken: v.string(),
        severity: v.optional(severityV),
        acknowledged: v.optional(v.boolean()),
        limit: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)

        const limit = Math.max(1, Math.min(args.limit ?? 20, 100))
        const alerts: Doc<"alerts">[] = []
        const pageSize = Math.max(50, limit * 4)
        let cursor: string | null = null

        while (alerts.length < limit) {
            const page = await ctx.db
                .query("alerts")
                .order("desc")
                .paginate({
                    cursor,
                    numItems: pageSize,
                })

            for (const alert of page.page) {
                if (args.severity !== undefined && alert.severity !== args.severity) {
                    continue
                }
                if (args.acknowledged !== undefined && alert.acknowledged !== args.acknowledged) {
                    continue
                }

                alerts.push(alert)
                if (alerts.length >= limit) {
                    break
                }
            }

            if (page.isDone) {
                break
            }
            cursor = page.continueCursor
        }

        return alerts.map((alert) => ({
            id: String(alert._id),
            strategyId: alert.strategyId ? String(alert.strategyId) : undefined,
            app: alert.app,
            severity: alert.severity,
            message: alert.message,
            acknowledged: alert.acknowledged,
            timestamp: alert.timestamp,
        }))
    },
})

export const getFullResetAudit = query({
    args: {
        serviceToken: v.string(),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)

        const [
            strategies,
            runs,
            agentLogs,
            tradeEvents,
            orders,
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
            alerts,
        ] = await Promise.all([
            ctx.db.query("strategies").take(1),
            ctx.db.query("strategy_runs").take(1),
            ctx.db.query("agent_logs").take(1),
            ctx.db.query("trade_events").take(1),
            ctx.db.query("orders").take(1),
            ctx.db.query("order_transitions").take(1),
            ctx.db.query("positions").take(1),
            ctx.db.query("instrument_claims").take(1),
            ctx.db.query("position_syncs").take(1),
            ctx.db.query("strategy_risk_states").take(1),
            ctx.db.query("execution_safety_faults").take(1),
            ctx.db.query("provider_positions").take(1),
            ctx.db.query("provider_working_orders").take(1),
            ctx.db.query("provider_sync_state").take(1),
            ctx.db.query("account_snapshots").take(1),
            ctx.db.query("app_heartbeats").take(1),
            ctx.db.query("manual_run_requests").take(1),
            ctx.db.query("alerts").take(1),
        ])

        return {
            strategies: strategies.length,
            runs: runs.length,
            agentLogs: agentLogs.length,
            tradeEvents: tradeEvents.length,
            orders: orders.length,
            orderTransitions: orderTransitions.length,
            positions: positions.length,
            instrumentClaims: instrumentClaims.length,
            positionSyncs: positionSyncs.length,
            strategyRiskStates: strategyRiskStates.length,
            executionSafetyFaults: executionSafetyFaults.length,
            providerPositions: providerPositions.length,
            providerWorkingOrders: providerWorkingOrders.length,
            providerSyncStates: providerSyncStates.length,
            accountSnapshots: accountSnapshots.length,
            appHeartbeats: appHeartbeats.length,
            manualRunRequests: manualRunRequests.length,
            alerts: alerts.length,
        }
    },
})

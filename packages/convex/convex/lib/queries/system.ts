import { query } from "../../_generated/server"
import { v } from "convex/values"
import { requireUser, requireServiceToken, requireUserOrServiceToken } from "../authGuards"

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
                    okx_swap: false,
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

export const getAppHealth = query({
    args: {},
    handler: async (ctx) => {
        await requireUser(ctx)
        return await ctx.db.query("app_heartbeats").collect()
    },
})

export const getManualRunRequests = query({
    args: {
        serviceToken: v.string(),
        app: v.union(
            v.literal("alpaca-options"),
            v.literal("polymarket"),
            v.literal("mt5"),
            v.literal("okx-swap")
        ),
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
            providerPositions,
            providerWorkingOrders,
            providerSyncStates,
            accountSnapshots,
            appHeartbeats,
            manualRunRequests,
            alerts,
        ] = await Promise.all([
            ctx.db.query("strategies").collect(),
            ctx.db.query("strategy_runs").collect(),
            ctx.db.query("agent_logs").collect(),
            ctx.db.query("trade_events").collect(),
            ctx.db.query("orders").collect(),
            ctx.db.query("order_transitions").collect(),
            ctx.db.query("positions").collect(),
            ctx.db.query("instrument_claims").collect(),
            ctx.db.query("position_syncs").collect(),
            ctx.db.query("provider_positions").collect(),
            ctx.db.query("provider_working_orders").collect(),
            ctx.db.query("provider_sync_state").collect(),
            ctx.db.query("account_snapshots").collect(),
            ctx.db.query("app_heartbeats").collect(),
            ctx.db.query("manual_run_requests").collect(),
            ctx.db.query("alerts").collect(),
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

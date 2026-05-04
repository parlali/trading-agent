import { mutation } from "../../_generated/server"
import { v } from "convex/values"
import { requireUser, requireServiceToken } from "../authGuards"
import { createDefaultKillSwitchState, toKillSwitchKey } from "../killSwitchState"
import { accountSnapshotValueFieldsV, appV, severityV } from "../validators"

export const createAlert = mutation({
    args: {
        serviceToken: v.string(),
        strategyId: v.optional(v.id("strategies")),
        app: v.optional(appV),
        severity: severityV,
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

export {
    reportHeartbeat,
    reportHeartbeatLiveness,
    reportHeartbeatSnapshot,
} from "./systemHeartbeats"

export const snapshotAccountState = mutation({
    args: {
        serviceToken: v.string(),
        app: appV,
        venue: v.string(),
        ...accountSnapshotValueFieldsV,
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
            v.literal("okx-swap")
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
                ...createDefaultKillSwitchState(args.scope, args.enabled),
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
            const killSwitchKey = toKillSwitchKey(args.scope)
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

export {
    ackManualRunRequest,
    claimManualRunRequests,
    clearManualRunRequest,
} from "./systemManualRuns"

export {
    clearFullResetState,
    clearFullResetStateBatch,
} from "./systemReset"

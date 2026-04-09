import { mutation } from "../../_generated/server";
import { v } from "convex/values";
import { requireUser, requireServiceToken } from "../authGuards";
export const createAlert = mutation({
    args: {
        serviceToken: v.string(),
        strategyId: v.optional(v.id("strategies")),
        app: v.optional(v.union(v.literal("alpaca-options"), v.literal("polymarket"), v.literal("mt5"), v.literal("binance-futures"), v.literal("backend"))),
        severity: v.union(v.literal("critical"), v.literal("warning"), v.literal("info")),
        message: v.string(),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken);
        await ctx.db.insert("alerts", {
            strategyId: args.strategyId,
            app: args.app,
            severity: args.severity,
            message: args.message,
            acknowledged: false,
            timestamp: Date.now(),
        });
    },
});
export const acknowledgeAlert = mutation({
    args: {
        alertId: v.id("alerts"),
    },
    handler: async (ctx, args) => {
        await requireUser(ctx);
        await ctx.db.patch(args.alertId, {
            acknowledged: true,
        });
    },
});
export const reportHeartbeat = mutation({
    args: {
        serviceToken: v.string(),
        app: v.union(v.literal("alpaca-options"), v.literal("polymarket"), v.literal("mt5"), v.literal("binance-futures"), v.literal("backend")),
        status: v.union(v.literal("healthy"), v.literal("degraded"), v.literal("unhealthy")),
        metadata: v.optional(v.any()),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken);
        const existing = await ctx.db
            .query("app_heartbeats")
            .withIndex("by_app", (q) => q.eq("app", args.app))
            .first();
        const payload = {
            app: args.app,
            status: args.status,
            lastHeartbeat: Date.now(),
            metadata: args.metadata,
        };
        if (existing) {
            await ctx.db.patch(existing._id, payload);
            return existing._id;
        }
        return await ctx.db.insert("app_heartbeats", payload);
    },
});
export const snapshotAccountState = mutation({
    args: {
        serviceToken: v.string(),
        app: v.union(v.literal("alpaca-options"), v.literal("polymarket"), v.literal("mt5"), v.literal("binance-futures"), v.literal("backend")),
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
        requireServiceToken(args.serviceToken);
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
        });
    },
});
export const setKillSwitch = mutation({
    args: {
        scope: v.union(v.literal("global"), v.literal("alpaca-options"), v.literal("polymarket"), v.literal("mt5"), v.literal("binance-futures")),
        enabled: v.boolean(),
        updatedBy: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        await requireUser(ctx);
        const existing = await ctx.db
            .query("system_state")
            .withIndex("by_key", (q) => q.eq("key", "kill_switches"))
            .first();
        const now = Date.now();
        if (!existing) {
            const state = {
                key: "kill_switches",
                globalKillSwitch: args.scope === "global" ? args.enabled : false,
                appKillSwitches: {
                    alpaca_options: args.scope === "alpaca-options" ? args.enabled : false,
                    polymarket: args.scope === "polymarket" ? args.enabled : false,
                    mt5: args.scope === "mt5" ? args.enabled : false,
                    binance_futures: args.scope === "binance-futures" ? args.enabled : false,
                },
                updatedAt: now,
                updatedBy: args.updatedBy,
            };
            return await ctx.db.insert("system_state", state);
        }
        if (args.scope === "global") {
            await ctx.db.patch(existing._id, {
                globalKillSwitch: args.enabled,
                updatedAt: now,
                updatedBy: args.updatedBy,
            });
        }
        else {
            const killSwitchKey = args.scope.replace(/-/g, "_");
            await ctx.db.patch(existing._id, {
                appKillSwitches: {
                    ...existing.appKillSwitches,
                    [killSwitchKey]: args.enabled,
                },
                updatedAt: now,
                updatedBy: args.updatedBy,
            });
        }
        return existing._id;
    },
});
export const clearManualRunRequest = mutation({
    args: {
        serviceToken: v.string(),
        requestId: v.id("manual_run_requests"),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken);
        await ctx.db.delete(args.requestId);
    },
});

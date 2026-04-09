import { query } from "../../_generated/server";
import { v } from "convex/values";
import { requireUser, requireServiceToken, requireUserOrServiceToken } from "../authGuards";
export const getSystemState = query({
    args: { serviceToken: v.optional(v.string()) },
    handler: async (ctx, args) => {
        await requireUserOrServiceToken(ctx, args.serviceToken);
        const state = await ctx.db
            .query("system_state")
            .withIndex("by_key", (q) => q.eq("key", "kill_switches"))
            .first();
        if (!state) {
            return {
                globalKillSwitch: false,
                appKillSwitches: {
                    alpaca_options: false,
                    polymarket: false,
                    mt5: false,
                    binance_futures: false,
                },
                updatedAt: 0,
            };
        }
        return {
            globalKillSwitch: state.globalKillSwitch,
            appKillSwitches: state.appKillSwitches,
            updatedAt: state.updatedAt,
        };
    },
});
export const getAppHealth = query({
    args: {},
    handler: async (ctx) => {
        await requireUser(ctx);
        return await ctx.db.query("app_heartbeats").collect();
    },
});
export const getManualRunRequests = query({
    args: {
        serviceToken: v.string(),
        app: v.union(v.literal("alpaca-options"), v.literal("polymarket"), v.literal("mt5"), v.literal("binance-futures")),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken);
        return await ctx.db
            .query("manual_run_requests")
            .withIndex("by_app", (q) => q.eq("app", args.app))
            .order("desc")
            .collect();
    },
});

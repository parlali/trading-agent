import { query } from "../../_generated/server";
import { v } from "convex/values";
import { requireUser, requireServiceToken, requireUserOrServiceToken } from "../authGuards";
import { getOwnedInstrumentsByApp, getOwnedInstrumentsForStrategy, } from "../instrumentClaims";
export const getStrategyConfigs = query({
    args: {
        serviceToken: v.string(),
        app: v.union(v.literal("alpaca-options"), v.literal("polymarket"), v.literal("mt5"), v.literal("binance-futures")),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken);
        return await ctx.db
            .query("strategies")
            .withIndex("by_app_enabled", (q) => q.eq("app", args.app).eq("enabled", true))
            .collect();
    },
});
export const getStrategyById = query({
    args: { serviceToken: v.optional(v.string()), id: v.id("strategies") },
    handler: async (ctx, args) => {
        await requireUserOrServiceToken(ctx, args.serviceToken);
        return await ctx.db.get(args.id);
    },
});
export const getAllStrategies = query({
    args: {
        serviceToken: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        if (args.serviceToken) {
            requireServiceToken(args.serviceToken);
        }
        else {
            await requireUser(ctx);
        }
        return await ctx.db.query("strategies").collect();
    },
});
export const getStrategyOwnedInstruments = query({
    args: { serviceToken: v.string(), strategyId: v.id("strategies") },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken);
        return await getOwnedInstrumentsForStrategy(ctx, args.strategyId);
    },
});
export const getAllOwnedInstrumentsByApp = query({
    args: {
        serviceToken: v.string(),
        app: v.union(v.literal("alpaca-options"), v.literal("polymarket"), v.literal("mt5"), v.literal("binance-futures")),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken);
        return await getOwnedInstrumentsByApp(ctx, args.app);
    },
});

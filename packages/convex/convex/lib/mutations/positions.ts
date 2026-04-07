import { mutation } from "../../_generated/server"
import { v } from "convex/values"
import { requireServiceToken } from "../authGuards"
import { replacePositionClaims } from "../instrumentClaims"

export const syncPositions = mutation({
    args: {
        serviceToken: v.string(),
        strategyId: v.id("strategies"),
        app: v.union(
            v.literal("alpaca-options"),
            v.literal("polymarket"),
            v.literal("mt5"),
            v.literal("binance-futures")
        ),
        positions: v.array(
            v.object({
                instrument: v.string(),
                side: v.union(v.literal("long"), v.literal("short")),
                quantity: v.number(),
                entryPrice: v.number(),
                currentPrice: v.optional(v.number()),
                unrealizedPnl: v.optional(v.number()),
                metadata: v.optional(v.string()),
            })
        ),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        const now = Date.now()
        await ctx.db.insert("position_syncs", {
            strategyId: args.strategyId,
            app: args.app,
            syncedAt: now,
            positionCount: args.positions.length,
        })

        for (const pos of args.positions) {
            await ctx.db.insert("positions", {
                strategyId: args.strategyId,
                app: args.app,
                instrument: pos.instrument,
                side: pos.side,
                quantity: pos.quantity,
                entryPrice: pos.entryPrice,
                currentPrice: pos.currentPrice,
                unrealizedPnl: pos.unrealizedPnl,
                metadata: pos.metadata,
                syncedAt: now,
            })
        }

        await replacePositionClaims(ctx, {
            strategyId: args.strategyId,
            app: args.app,
            instruments: args.positions.map((position) => position.instrument),
            updatedAt: now,
        })
    },
})

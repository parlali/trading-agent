import { query } from "../../_generated/server"
import { v } from "convex/values"
import { requireUser, requireServiceToken } from "../authGuards"
import { getLatestPositionsForStrategy } from "../instrumentClaims"

export const getOpenPositions = query({
    args: { strategyId: v.id("strategies") },
    handler: async (ctx, args) => {
        await requireUser(ctx)
        return await getLatestPositionsForStrategy(ctx, args.strategyId)
    },
})

export const getStrategyPositions = query({
    args: { serviceToken: v.string(), strategyId: v.id("strategies") },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        return await getLatestPositionsForStrategy(ctx, args.strategyId)
    },
})

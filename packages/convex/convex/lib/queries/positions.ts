import { query } from "../../_generated/server"
import { v } from "convex/values"
import { requireUser } from "../authGuards"
import { getLatestPositionsForStrategy } from "../instrumentClaims"

export const getOpenPositions = query({
    args: { strategyId: v.id("strategies") },
    handler: async (ctx, args) => {
        await requireUser(ctx)
        return await getLatestPositionsForStrategy(ctx, args.strategyId)
    },
})

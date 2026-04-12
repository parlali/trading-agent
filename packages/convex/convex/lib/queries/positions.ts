import { query } from "../../_generated/server"
import { v } from "convex/values"
import { requireUser, requireServiceToken } from "../authGuards"
import { getLatestPositionsForStrategy } from "../instrumentClaims"
import { isDryRunLedgerMetadata } from "../dryRunLedger"

export const getOpenPositions = query({
    args: { strategyId: v.id("strategies") },
    handler: async (ctx, args) => {
        await requireUser(ctx)
        const positions = await getLatestPositionsForStrategy(ctx, args.strategyId)
        return positions.filter((position) => !isDryRunLedgerMetadata(position.metadata))
    },
})

export const getStrategyPositions = query({
    args: { serviceToken: v.string(), strategyId: v.id("strategies") },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        return await getLatestPositionsForStrategy(ctx, args.strategyId)
    },
})

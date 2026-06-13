import { mutation } from "../../_generated/server"
import { v } from "convex/values"
import { requireServiceToken } from "../authGuards"
import { replacePositionClaims } from "../instrumentClaims"
import { isDryRunLedgerMetadata } from "../dryRunLedger"
import {
    buildPositionClaim,
    buildProviderPositionKey,
} from "../providerPositions"
import {
    positionValueFieldsV,
    venueAppV,
} from "../validators"

export const syncPositions = mutation({
    args: {
        serviceToken: v.string(),
        strategyId: v.id("strategies"),
        app: venueAppV,
        positions: v.array(
            v.object({
                providerPositionId: v.optional(v.string()),
                ...positionValueFieldsV,
                metadata: v.optional(v.string()),
            })
        ),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        const strategy = await ctx.db.get(args.strategyId)
        if (!strategy) {
            throw new Error(`Strategy not found: ${args.strategyId}`)
        }
        if (strategy.app !== args.app) {
            throw new Error(`Position sync app mismatch for strategy ${args.strategyId}: ${args.app} !== ${strategy.app}`)
        }

        const now = Date.now()
        await ctx.db.insert("position_syncs", {
            strategyId: args.strategyId,
            app: args.app,
            accountId: strategy.accountId,
            syncedAt: now,
            positionCount: args.positions.length,
        })

        for (const pos of args.positions) {
            await ctx.db.insert("positions", {
                strategyId: args.strategyId,
                app: args.app,
                accountId: strategy.accountId,
                positionKey: buildProviderPositionKey(pos),
                providerPositionId: pos.providerPositionId,
                instrument: pos.instrument,
                side: pos.side,
                quantity: pos.quantity,
                entryPrice: pos.entryPrice,
                currentPrice: pos.currentPrice,
                unrealizedPnl: pos.unrealizedPnl,
                stopLoss: pos.stopLoss,
                takeProfit: pos.takeProfit,
                metadata: pos.metadata,
                syncedAt: now,
            })
        }

        await replacePositionClaims(ctx, {
            strategyId: args.strategyId,
            app: args.app,
            accountId: strategy.accountId,
            positionClaims: args.positions
                .filter((position) => !isDryRunLedgerMetadata(position.metadata))
                .map((position) => buildPositionClaim(position)),
            updatedAt: now,
        })
    },
})

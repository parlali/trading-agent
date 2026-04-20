import { query } from "../../_generated/server"
import { v } from "convex/values"
import { requireUserOrServiceToken } from "../authGuards"

export const getStrategyRiskState = query({
    args: {
        serviceToken: v.optional(v.string()),
        strategyId: v.id("strategies"),
    },
    handler: async (ctx, args) => {
        await requireUserOrServiceToken(ctx, args.serviceToken)

        const row = await ctx.db
            .query("strategy_risk_states")
            .withIndex("by_strategy", (q) => q.eq("strategyId", args.strategyId))
            .first()

        if (!row) {
            return null
        }

        return {
            strategyId: String(row.strategyId),
            app: row.app,
            safetyState: row.safetyState,
            day: {
                realizedPnl: row.dayRealizedPnl,
                limit: row.dayDrawdownLimit,
                progress: row.dayDrawdownProgress,
            },
            week: {
                realizedPnl: row.weekRealizedPnl,
                limit: row.weekDrawdownLimit,
                progress: row.weekDrawdownProgress,
            },
            cooldown: {
                active: row.cooldownActive,
                reason: row.cooldownReason,
                startedAt: row.cooldownStartedAt,
                expiresAt: row.cooldownExpiresAt,
            },
            blockedInstruments: row.blockedInstruments,
            forcedExitClusterInstruments: row.forcedExitClusterInstruments ?? [],
            unresolvedExecutionFaultCount: row.unresolvedExecutionFaultCount,
            lastUpdatedAt: row.updatedAt,
        }
    },
})

export const getStrategyExecutionSafetyFaults = query({
    args: {
        serviceToken: v.optional(v.string()),
        strategyId: v.id("strategies"),
        unresolvedOnly: v.optional(v.boolean()),
    },
    handler: async (ctx, args) => {
        await requireUserOrServiceToken(ctx, args.serviceToken)

        const faults = await ctx.db
            .query("execution_safety_faults")
            .withIndex("by_strategy", (q) => q.eq("strategyId", args.strategyId))
            .collect()

        return faults
            .filter((fault) => args.unresolvedOnly ? fault.resolvedAt === undefined : true)
            .sort((left, right) => right.occurredAt - left.occurredAt)
    },
})

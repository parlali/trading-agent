import { mutation } from "../../_generated/server"
import type { Doc, Id } from "../../_generated/dataModel"
import { v } from "convex/values"
import { computeRiskGovernanceState } from "@valiq-trading/core"
import { requireServiceToken } from "../authGuards"
import { venueAppV, executionSafetyFaultCategoryV } from "../validators"

const riskPolicyInputV = v.object({
    maxDrawdownDay: v.optional(v.number()),
    maxDrawdownWeek: v.optional(v.number()),
    cooldownMinutesAfterDayBreach: v.number(),
    cooldownMinutesAfterWeekBreach: v.number(),
    strategyTimezone: v.string(),
})

export const refreshStrategyRiskState = mutation({
    args: {
        serviceToken: v.string(),
        strategyId: v.id("strategies"),
        app: venueAppV,
        policy: riskPolicyInputV,
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)

        const strategy = await ctx.db.get(args.strategyId)
        if (!strategy) {
            throw new Error(`Strategy not found: ${args.strategyId}`)
        }

        if (strategy.app !== args.app) {
            throw new Error(`Strategy ${args.strategyId} does not belong to ${args.app}`)
        }

        const now = Date.now()

        const [filledOrders, partiallyFilledOrders, existingRiskState, strategyFaults] = await Promise.all([
            ctx.db
                .query("orders")
                .withIndex("by_strategy_status", (q) => q.eq("strategyId", args.strategyId).eq("status", "filled"))
                .collect(),
            ctx.db
                .query("orders")
                .withIndex("by_strategy_status", (q) => q.eq("strategyId", args.strategyId).eq("status", "partially_filled"))
                .collect(),
            ctx.db
                .query("strategy_risk_states")
                .withIndex("by_strategy", (q) => q.eq("strategyId", args.strategyId))
                .first(),
            ctx.db
                .query("execution_safety_faults")
                .withIndex("by_strategy", (q) => q.eq("strategyId", args.strategyId))
                .collect(),
        ])
        const governance = computeRiskGovernanceState({
            now,
            orders: [...filledOrders, ...partiallyFilledOrders],
            faults: strategyFaults,
            policy: args.policy,
            existing: existingRiskState
                ? {
                    cooldownActive: existingRiskState.cooldownActive,
                    cooldownReason: existingRiskState.cooldownReason,
                    cooldownStartedAt: existingRiskState.cooldownStartedAt,
                    cooldownExpiresAt: existingRiskState.cooldownExpiresAt,
                    lastBreachReason: existingRiskState.lastBreachReason,
                }
                : undefined,
        })

        if (governance.cooldown.expired) {
            await ctx.db.insert("alerts", {
                strategyId: args.strategyId,
                app: args.app,
                severity: "info",
                message: `[risk] Cooldown expired for ${strategy.name}`,
                acknowledged: false,
                timestamp: now,
            })
        }

        if (governance.cooldown.entered && governance.cooldown.enteredReason && governance.cooldown.expiresAt !== undefined) {
            const reason = governance.cooldown.enteredReason
            const message = reason === "forced_exit_cluster"
                ? `[risk] ${strategy.name} entered cooldown due to repeated forced exits (${governance.forcedExitClusterInstruments.join(", ")}). Expires at ${new Date(governance.cooldown.expiresAt).toISOString()}`
                : `[risk] ${strategy.name} entered cooldown due to ${reason.replace("_", " ")} breach. Expires at ${new Date(governance.cooldown.expiresAt).toISOString()}`
            await ctx.db.insert("alerts", {
                strategyId: args.strategyId,
                app: args.app,
                severity: "warning",
                message,
                acknowledged: false,
                timestamp: now,
            })
        }

        const safetyState: Doc<"strategy_risk_states">["safetyState"] = governance.safetyState

        const nextState = {
            strategyId: args.strategyId,
            app: args.app,
            safetyState,
            dayRealizedPnl: governance.dayRealizedPnl,
            weekRealizedPnl: governance.weekRealizedPnl,
            dayDrawdownLimit: args.policy.maxDrawdownDay,
            weekDrawdownLimit: args.policy.maxDrawdownWeek,
            dayDrawdownProgress: governance.dayDrawdownProgress,
            weekDrawdownProgress: governance.weekDrawdownProgress,
            cooldownActive: governance.cooldown.active,
            cooldownReason: governance.cooldown.reason,
            cooldownStartedAt: governance.cooldown.startedAt,
            cooldownExpiresAt: governance.cooldown.expiresAt,
            blockedInstruments: governance.blockedInstruments,
            forcedExitClusterInstruments: governance.forcedExitClusterInstruments,
            unresolvedExecutionFaultCount: governance.unresolvedExecutionFaultCount,
            lastBreachReason: governance.lastBreachReason,
            updatedAt: now,
        }

        if (existingRiskState) {
            await ctx.db.patch(existingRiskState._id, nextState)
        } else {
            await ctx.db.insert("strategy_risk_states", nextState)
        }

        return {
            strategyId: String(args.strategyId),
            app: args.app,
            safetyState,
            day: {
                realizedPnl: governance.dayRealizedPnl,
                limit: args.policy.maxDrawdownDay,
                progress: nextState.dayDrawdownProgress,
            },
            week: {
                realizedPnl: governance.weekRealizedPnl,
                limit: args.policy.maxDrawdownWeek,
                progress: nextState.weekDrawdownProgress,
            },
            cooldown: {
                active: governance.cooldown.active,
                reason: governance.cooldown.reason,
                startedAt: governance.cooldown.startedAt,
                expiresAt: governance.cooldown.expiresAt,
            },
            blockedInstruments: governance.blockedInstruments,
            forcedExitClusterInstruments: governance.forcedExitClusterInstruments,
            unresolvedExecutionFaultCount: governance.unresolvedExecutionFaultCount,
            lastUpdatedAt: now,
        }
    },
})

export const recordExecutionSafetyFault = mutation({
    args: {
        serviceToken: v.string(),
        strategyId: v.id("strategies"),
        app: venueAppV,
        instrument: v.string(),
        category: executionSafetyFaultCategoryV,
        message: v.string(),
        providerPayload: v.optional(v.string()),
        blocked: v.optional(v.boolean()),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)

        const strategy = await ctx.db.get(args.strategyId)
        if (!strategy) {
            throw new Error(`Strategy not found: ${args.strategyId}`)
        }

        const now = Date.now()
        const blocked = args.blocked ?? true
        const insertedId = await ctx.db.insert("execution_safety_faults", {
            strategyId: args.strategyId,
            app: args.app,
            instrument: args.instrument,
            category: args.category,
            message: args.message,
            providerPayload: args.providerPayload,
            blocked,
            occurredAt: now,
            resolvedAt: undefined,
            resolutionNote: undefined,
        })

        await ctx.db.insert("alerts", {
            strategyId: args.strategyId,
            app: args.app,
            severity: "critical",
            message: `[execution-safety] ${strategy.name} ${args.instrument}: ${args.category} -- ${args.message}`,
            acknowledged: false,
            timestamp: now,
        })

        return insertedId
    },
})

export const resolveExecutionSafetyFaults = mutation({
    args: {
        serviceToken: v.string(),
        strategyId: v.id("strategies"),
        instrument: v.string(),
        resolutionNote: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)

        const faults = await ctx.db
            .query("execution_safety_faults")
            .withIndex("by_strategy", (q) => q.eq("strategyId", args.strategyId))
            .collect()

        const openFaults = faults.filter((fault) =>
            fault.instrument === args.instrument &&
            fault.resolvedAt === undefined
        )

        if (openFaults.length === 0) {
            return {
                resolved: 0,
            }
        }

        const now = Date.now()
        for (const fault of openFaults) {
            await ctx.db.patch(fault._id, {
                blocked: false,
                resolvedAt: now,
                resolutionNote: args.resolutionNote,
            })
        }

        await ctx.db.insert("alerts", {
            strategyId: args.strategyId,
            app: openFaults[0]!.app,
            severity: "info",
            message: `[execution-safety] Cleared ${openFaults.length} fault(s) for ${args.instrument}`,
            acknowledged: false,
            timestamp: now,
        })

        return {
            resolved: openFaults.length,
        }
    },
})

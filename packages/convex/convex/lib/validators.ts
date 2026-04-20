import { v } from "convex/values"
import {
    VENUE_APPS,
    APPS,
    SEVERITY_LEVELS,
    EVENT_TYPES,
    PORTFOLIO_PROVIDER_STATUSES,
    PROVIDER_OWNERSHIP_STATUSES,
    STRATEGY_SAFETY_STATES,
    EXECUTION_SAFETY_FAULT_CATEGORIES,
} from "@valiq-trading/core"
import {
    ORDER_STATUSES,
    ORDER_ACTIONS,
    ORDER_TRANSITION_TYPES,
} from "@valiq-trading/core"

type LiteralValidator<T extends string> = ReturnType<typeof v.literal<T>>

function stringLiterals<const T extends readonly [string, ...string[]]>(values: T) {
    const validators = values.map((s) => v.literal(s))
    return v.union(
        ...(validators as [LiteralValidator<T[number]>, LiteralValidator<T[number]>, ...LiteralValidator<T[number]>[]])
    )
}

export const venueAppV = stringLiterals(VENUE_APPS)
export const appV = stringLiterals(APPS)
export const orderStatusV = stringLiterals(ORDER_STATUSES)
export const orderActionV = stringLiterals(ORDER_ACTIONS)
export const orderTransitionTypeV = stringLiterals(ORDER_TRANSITION_TYPES)
export const severityV = stringLiterals(SEVERITY_LEVELS)
export const eventTypeV = stringLiterals(EVENT_TYPES)

export const claimSourceV = v.union(
    v.literal("position"),
    v.literal("order"),
)

export const portfolioProviderStatusV = stringLiterals(PORTFOLIO_PROVIDER_STATUSES)
export const providerOwnershipStatusV = stringLiterals(PROVIDER_OWNERSHIP_STATUSES)
export const strategySafetyStateV = stringLiterals(STRATEGY_SAFETY_STATES)
export const executionSafetyFaultCategoryV = stringLiterals(EXECUTION_SAFETY_FAULT_CATEGORIES)

export const strategyCooldownReasonV = v.union(
    v.literal("day_drawdown"),
    v.literal("week_drawdown"),
    v.literal("forced_exit_cluster"),
    v.literal("execution_fault")
)

export const runSystemContextDigestV = v.object({
    schemaVersion: v.literal(1),
    generatedAt: v.number(),
    risk: v.object({
        safetyState: strategySafetyStateV,
        dayRealizedPnl: v.number(),
        weekRealizedPnl: v.number(),
        dayDrawdownLimit: v.optional(v.number()),
        weekDrawdownLimit: v.optional(v.number()),
        cooldownActive: v.boolean(),
        cooldownReason: v.optional(strategyCooldownReasonV),
        cooldownExpiresAt: v.optional(v.number()),
        blockedInstruments: v.array(v.string()),
        forcedExitClusterInstruments: v.array(v.string()),
        unresolvedExecutionFaultCount: v.number(),
    }),
    recentTrades: v.object({
        dayEntries: v.number(),
        dayCloses: v.number(),
        dayForcedExits: v.number(),
        dayRejectedOrTerminal: v.number(),
        weekRealizedPnl: v.number(),
        closeOutStreakDirection: v.optional(v.union(v.literal("win"), v.literal("loss"))),
        closeOutStreakCount: v.number(),
    }),
    pendingOrders: v.array(v.object({
        orderId: v.string(),
        instrument: v.string(),
        action: orderActionV,
        status: orderStatusV,
        cancelAt: v.optional(v.number()),
    })),
})

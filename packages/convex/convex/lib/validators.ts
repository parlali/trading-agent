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
    EXECUTION_COMMIT_OUTCOMES,
} from "@valiq-trading/core"
import { AGENT_CHAT_TOOL_PAYLOAD_SCHEMA_VERSION } from "./agentChatToolPayload"
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
export const executionCommitOutcomeV = stringLiterals(EXECUTION_COMMIT_OUTCOMES)
export const severityV = stringLiterals(SEVERITY_LEVELS)
export const eventTypeV = stringLiterals(EVENT_TYPES)
export const heartbeatStatusV = stringLiterals(["healthy", "degraded", "unhealthy"])
export const agentLogRoleV = stringLiterals(["system", "user", "assistant", "tool"])

export const agentChatToolPayloadV = v.object({
    schemaVersion: v.literal(AGENT_CHAT_TOOL_PAYLOAD_SCHEMA_VERSION),
    encoding: v.literal("json"),
    json: v.string(),
})

export const mcpToolSkipReasonV = stringLiterals([
    "provider_unavailable",
    "provider_blocked",
    "strategy_whitelist_missing",
    "strategy_whitelist_empty",
    "provider_not_configured",
    "not_whitelisted",
    "tool_disappeared",
    "schema_changed",
    "registered_name_changed",
    "schema_incompatible",
    "unsafe_annotation",
    "invalid_name",
    "malformed_tool",
    "duplicate_upstream_tool",
    "duplicate_registered_name",
    "discovery_tool",
    "nested_discovery_failed",
    "nested_discovery_unsupported_schema",
    "discovery_limit_exceeded",
])

export const mcpToolDiscoverySourceV = v.union(
    v.literal("tools/list"),
    v.literal("tools/discover"),
    v.literal("tool_search")
)

export const mcpToolAnnotationsV = v.object({
    readOnlyHint: v.optional(v.boolean()),
    destructiveHint: v.optional(v.boolean()),
    openWorldHint: v.optional(v.boolean()),
})

export const mcpToolApprovalV = v.object({
    providerId: v.string(),
    toolName: v.string(),
    registeredName: v.string(),
    schemaHash: v.string(),
    description: v.optional(v.string()),
    source: v.optional(mcpToolDiscoverySourceV),
    inputSchema: v.optional(v.any()),
    annotations: v.optional(mcpToolAnnotationsV),
    approvedAt: v.optional(v.number()),
    approvedBy: v.optional(v.string()),
    approvalReason: v.optional(v.string()),
})

export const mcpToolDiagnosticV = v.object({
    providerId: v.string(),
    upstreamToolName: v.optional(v.string()),
    registeredName: v.optional(v.string()),
    source: v.optional(mcpToolDiscoverySourceV),
    reason: mcpToolSkipReasonV,
    message: v.string(),
    schemaReason: v.optional(v.string()),
    annotationReason: v.optional(v.string()),
})

export const claimSourceV = v.union(
    v.literal("position"),
    v.literal("order"),
)

export const portfolioProviderStatusV = stringLiterals(PORTFOLIO_PROVIDER_STATUSES)
export const providerOwnershipStatusV = stringLiterals(PROVIDER_OWNERSHIP_STATUSES)
export const strategySafetyStateV = stringLiterals(STRATEGY_SAFETY_STATES)
export const executionSafetyFaultCategoryV = stringLiterals(EXECUTION_SAFETY_FAULT_CATEGORIES)

export const positionSideV = v.union(v.literal("long"), v.literal("short"))

export const positionValueFieldsV = {
    instrument: v.string(),
    side: positionSideV,
    quantity: v.number(),
    entryPrice: v.number(),
    currentPrice: v.optional(v.number()),
    unrealizedPnl: v.optional(v.number()),
    stopLoss: v.optional(v.number()),
    takeProfit: v.optional(v.number()),
}

export const accountSnapshotValueFieldsV = {
    balance: v.number(),
    equity: v.optional(v.number()),
    buyingPower: v.number(),
    marginUsed: v.number(),
    marginAvailable: v.number(),
    openPnl: v.number(),
    dayPnl: v.number(),
}

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

export const orderPollingV = v.object({
    pollIntervalMs: v.number(),
    timeoutMs: v.number(),
    startedAt: v.number(),
    lastCheckedAt: v.number(),
    nextCheckAt: v.optional(v.number()),
    timedOutAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    resumeToken: v.optional(v.string()),
})

export const orderCoreFieldsV = {
    orderId: v.string(),
    canonicalOrderId: v.optional(v.string()),
    providerOrderId: v.string(),
    providerClientOrderId: v.optional(v.string()),
    providerOrderAliases: v.optional(v.array(v.string())),
    submitAttemptId: v.optional(v.string()),
    submitAttemptSequence: v.optional(v.number()),
    commitOutcome: v.optional(executionCommitOutcomeV),
    signedOrderFingerprint: v.optional(v.string()),
    signedOrderMetadata: v.optional(v.any()),
    runId: v.id("strategy_runs"),
    strategyId: v.id("strategies"),
    accountId: v.optional(v.string()),
    venue: v.string(),
    instrument: v.string(),
    status: orderStatusV,
    action: orderActionV,
    quantity: v.number(),
    filledQuantity: v.number(),
    remainingQuantity: v.number(),
    avgFillPrice: v.optional(v.number()),
    submittedAt: v.number(),
    updatedAt: v.number(),
    intent: v.any(),
    metadata: v.optional(v.any()),
    lastTransitionSequence: v.number(),
    polling: orderPollingV,
}

export const orderRowFieldsV = {
    ...orderCoreFieldsV,
    app: v.optional(venueAppV),
}

export const orderTransitionCoreFieldsV = {
    orderId: v.string(),
    runId: v.id("strategy_runs"),
    strategyId: v.id("strategies"),
    type: orderTransitionTypeV,
    status: orderStatusV,
    previousStatus: v.optional(orderStatusV),
    reason: v.optional(v.string()),
    details: v.optional(v.any()),
    timestamp: v.number(),
}

export const orderTransitionRowFieldsV = {
    ...orderTransitionCoreFieldsV,
    sequence: v.number(),
}

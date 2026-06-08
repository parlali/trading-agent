import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"
import { authTables } from "@convex-dev/auth/server"
import {
    venueAppV,
    appV,
    orderStatusV,
    orderActionV,
    severityV,
    eventTypeV,
    heartbeatStatusV,
    agentLogRoleV,
    claimSourceV,
    portfolioProviderStatusV,
    providerOwnershipStatusV,
    strategySafetyStateV,
    executionSafetyFaultCategoryV,
    runSystemContextDigestV,
    strategyCooldownReasonV,
    orderRowFieldsV,
    orderTransitionRowFieldsV,
    positionValueFieldsV,
    accountSnapshotValueFieldsV,
} from "./lib/validators"

const heartbeatStateFields = {
    app: appV,
    status: heartbeatStatusV,
    metadata: v.optional(v.any()),
}

export default defineSchema({
    ...authTables,

    strategies: defineTable({
        app: venueAppV,
        name: v.string(),
        enabled: v.boolean(),
        schedule: v.string(),
        policy: v.any(),
        context: v.string(),
        createdAt: v.number(),
        updatedAt: v.number(),
    })
        .index("by_app", ["app"])
        .index("by_app_enabled", ["app", "enabled"]),

    strategy_runs: defineTable({
        strategyId: v.id("strategies"),
        app: venueAppV,
        status: v.union(
            v.literal("running"),
            v.literal("completed"),
            v.literal("failed")
        ),
        trigger: v.optional(v.union(
            v.literal("cron"),
            v.literal("manual"),
            v.literal("callback")
        )),
        startedAt: v.number(),
        endedAt: v.optional(v.number()),
        summary: v.optional(v.string()),
        error: v.optional(v.string()),
        callbackRequestedMinutes: v.optional(v.number()),
        callbackFiresAt: v.optional(v.number()),
        degradedResearch: v.optional(v.boolean()),
        degradedReason: v.optional(v.string()),
        toolFailureCount: v.optional(v.number()),
        toolRetryCount: v.optional(v.number()),
        decisionUnderDegradedContext: v.optional(v.boolean()),
        promptTokens: v.optional(v.number()),
        completionTokens: v.optional(v.number()),
        reasoningTokens: v.optional(v.number()),
        llmCost: v.optional(v.number()),
        llmProvider: v.optional(v.union(v.literal("openrouter"), v.literal("codex"))),
        llmModel: v.optional(v.string()),
        llmAuthMode: v.optional(v.string()),
        llmBillingMode: v.optional(v.string()),
        llmResponseIds: v.optional(v.array(v.string())),
        codexThreadId: v.optional(v.string()),
        codexTurnIds: v.optional(v.array(v.string())),
        llmRateLimitSnapshotBefore: v.optional(v.any()),
        llmRateLimitSnapshotAfter: v.optional(v.any()),
        openRouterResponseIds: v.optional(v.array(v.string())),
        opportunityResearched: v.optional(v.number()),
        opportunityQualified: v.optional(v.number()),
        opportunityRejectedByModel: v.optional(v.number()),
        opportunityRejectedByRisk: v.optional(v.number()),
        opportunitySubmitted: v.optional(v.number()),
        opportunityFilled: v.optional(v.number()),
        opportunityClosed: v.optional(v.number()),
        opportunityRealizedPnl: v.optional(v.number()),
        systemContextDigest: v.optional(runSystemContextDigestV),
    })
        .index("by_strategy", ["strategyId"])
        .index("by_strategy_status", ["strategyId", "status"])
        .index("by_status_started_at", ["status", "startedAt"]),

    agent_logs: defineTable({
        runId: v.id("strategy_runs"),
        strategyId: v.id("strategies"),
        sequence: v.number(),
        role: agentLogRoleV,
        content: v.string(),
        toolName: v.optional(v.string()),
        toolInput: v.optional(v.string()),
        toolOutput: v.optional(v.string()),
        timestamp: v.number(),
    })
        .index("by_run", ["runId"])
        .index("by_run_sequence", ["runId", "sequence"]),

    trade_events: defineTable({
        runId: v.id("strategy_runs"),
        strategyId: v.id("strategies"),
        app: v.optional(venueAppV),
        eventType: eventTypeV,
        payload: v.string(),
        timestamp: v.number(),
    })
        .index("by_run", ["runId"])
        .index("by_strategy", ["strategyId"])
        .index("by_app_timestamp", ["app", "timestamp"]),

    orders: defineTable({
        ...orderRowFieldsV,
    })
        .index("by_order_id", ["orderId"])
        .index("by_provider_order_id", ["providerOrderId"])
        .index("by_provider_client_order_id", ["providerClientOrderId"])
        .index("by_signed_order_fingerprint", ["signedOrderFingerprint"])
        .index("by_strategy_status", ["strategyId", "status"])
        .index("by_app_status", ["app", "status"])
        .index("by_run", ["runId"]),

    order_transitions: defineTable({
        ...orderTransitionRowFieldsV,
    })
        .index("by_order_sequence", ["orderId", "sequence"])
        .index("by_run", ["runId"]),

    positions: defineTable({
        strategyId: v.id("strategies"),
        app: venueAppV,
        positionKey: v.optional(v.string()),
        providerPositionId: v.optional(v.string()),
        ...positionValueFieldsV,
        metadata: v.optional(v.string()),
        syncedAt: v.number(),
    })
        .index("by_strategy", ["strategyId"])
        .index("by_strategy_synced_at", ["strategyId", "syncedAt"])
        .index("by_app", ["app"]),

    instrument_claims: defineTable({
        strategyId: v.id("strategies"),
        app: venueAppV,
        instrument: v.string(),
        source: claimSourceV,
        sourceId: v.string(),
        updatedAt: v.number(),
    })
        .index("by_strategy", ["strategyId"])
        .index("by_strategy_source", ["strategyId", "source"])
        .index("by_strategy_source_source_id", ["strategyId", "source", "sourceId"])
        .index("by_app", ["app"]),

    position_syncs: defineTable({
        strategyId: v.id("strategies"),
        app: venueAppV,
        syncedAt: v.number(),
        positionCount: v.number(),
        snapshotHash: v.optional(v.string()),
        decision: v.optional(v.string()),
    })
        .index("by_strategy_synced_at", ["strategyId", "syncedAt"])
        .index("by_app", ["app"]),

    alerts: defineTable({
        strategyId: v.optional(v.id("strategies")),
        app: v.optional(appV),
        severity: severityV,
        message: v.string(),
        acknowledged: v.boolean(),
        timestamp: v.number(),
    })
        .index("by_severity", ["severity"])
        .index("by_acknowledged", ["acknowledged"]),

    system_state: defineTable({
        key: v.literal("kill_switches"),
        globalKillSwitch: v.boolean(),
        appKillSwitches: v.object({
            alpaca_options: v.boolean(),
            polymarket: v.boolean(),
            mt5: v.boolean(),
            okx_swap: v.optional(v.boolean()),
        }),
        updatedAt: v.number(),
        updatedBy: v.optional(v.string()),
    }).index("by_key", ["key"]),

    app_heartbeats: defineTable({
        ...heartbeatStateFields,
        lastHeartbeat: v.number(),
    }).index("by_app", ["app"]),

    app_heartbeat_liveness: defineTable({
        ...heartbeatStateFields,
        lastHeartbeat: v.number(),
        updatedAt: v.number(),
    }).index("by_app", ["app"]),

    app_heartbeat_snapshots: defineTable({
        ...heartbeatStateFields,
        metadataHash: v.string(),
        lastSnapshotAt: v.number(),
        lastChangedAt: v.number(),
        suppressedWrites: v.number(),
        updatedAt: v.number(),
    }).index("by_app", ["app"]),

    control_plane_metrics: defineTable({
        metric: v.string(),
        app: v.optional(appV),
        value: v.number(),
        updatedAt: v.number(),
    })
        .index("by_metric", ["metric"])
        .index("by_metric_app", ["metric", "app"]),

    account_snapshots: defineTable({
        app: appV,
        venue: v.string(),
        ...accountSnapshotValueFieldsV,
        timestamp: v.number(),
    })
        .index("by_app", ["app"])
        .index("by_app_timestamp", ["app", "timestamp"]),

    provider_sync_state: defineTable({
        app: venueAppV,
        accountScope: v.literal("single-account-per-venue"),
        lastSyncedAt: v.optional(v.number()),
        lastVerifiedAt: v.optional(v.number()),
        providerStatus: portfolioProviderStatusV,
        stale: v.boolean(),
        driftDetected: v.boolean(),
        lastError: v.optional(v.string()),
        lastDriftSummary: v.optional(v.string()),
        lastAccountSnapshotHash: v.optional(v.string()),
        lastAccountSnapshotDecision: v.optional(v.string()),
        lastPositionSnapshotHash: v.optional(v.string()),
        lastPositionSnapshotDecision: v.optional(v.string()),
        lastReconciliationWriteStats: v.optional(v.any()),
        positionCount: v.number(),
        pendingOrderCount: v.number(),
        updatedAt: v.number(),
    }).index("by_app", ["app"]),

    provider_positions: defineTable({
        app: venueAppV,
        positionKey: v.string(),
        providerPositionId: v.optional(v.string()),
        strategyId: v.optional(v.id("strategies")),
        ownershipStatus: providerOwnershipStatusV,
        expectedExternal: v.optional(v.boolean()),
        ...positionValueFieldsV,
        metadata: v.optional(v.string()),
        syncedAt: v.number(),
    })
        .index("by_app", ["app"])
        .index("by_app_strategy", ["app", "strategyId"]),

    provider_working_orders: defineTable({
        app: venueAppV,
        orderId: v.string(),
        canonicalOrderId: v.optional(v.string()),
        providerOrderId: v.optional(v.string()),
        providerClientOrderId: v.optional(v.string()),
        providerOrderAliases: v.optional(v.array(v.string())),
        signedOrderFingerprint: v.optional(v.string()),
        strategyId: v.optional(v.id("strategies")),
        runId: v.optional(v.id("strategy_runs")),
        ownershipStatus: providerOwnershipStatusV,
        expectedExternal: v.optional(v.boolean()),
        venue: v.string(),
        instrument: v.string(),
        status: orderStatusV,
        action: v.optional(orderActionV),
        side: v.optional(v.union(v.literal("buy"), v.literal("sell"))),
        quantity: v.number(),
        filledQuantity: v.number(),
        remainingQuantity: v.number(),
        limitPrice: v.optional(v.number()),
        stopPrice: v.optional(v.number()),
        avgFillPrice: v.optional(v.number()),
        metadata: v.optional(v.string()),
        submittedAt: v.number(),
        updatedAt: v.number(),
        cancelAt: v.optional(v.number()),
        syncedAt: v.number(),
    })
        .index("by_app", ["app"])
        .index("by_provider_order_id", ["providerOrderId"])
        .index("by_provider_client_order_id", ["providerClientOrderId"])
        .index("by_app_strategy", ["app", "strategyId"])
        .index("by_app_status", ["app", "status"]),

    strategy_risk_states: defineTable({
        strategyId: v.id("strategies"),
        app: venueAppV,
        safetyState: strategySafetyStateV,
        dayRealizedPnl: v.number(),
        weekRealizedPnl: v.number(),
        dayDrawdownLimit: v.optional(v.number()),
        weekDrawdownLimit: v.optional(v.number()),
        dayDrawdownProgress: v.optional(v.number()),
        weekDrawdownProgress: v.optional(v.number()),
        cooldownActive: v.boolean(),
        cooldownReason: v.optional(strategyCooldownReasonV),
        cooldownStartedAt: v.optional(v.number()),
        cooldownExpiresAt: v.optional(v.number()),
        blockedInstruments: v.array(v.string()),
        forcedExitClusterInstruments: v.array(v.string()),
        unresolvedExecutionFaultCount: v.number(),
        lastBreachReason: v.optional(v.string()),
        updatedAt: v.number(),
    })
        .index("by_strategy", ["strategyId"])
        .index("by_app", ["app"])
        .index("by_app_state", ["app", "safetyState"]),

    execution_safety_faults: defineTable({
        strategyId: v.id("strategies"),
        app: venueAppV,
        instrument: v.string(),
        category: executionSafetyFaultCategoryV,
        message: v.string(),
        providerPayload: v.optional(v.string()),
        canonicalOrderId: v.optional(v.string()),
        providerOrderId: v.optional(v.string()),
        providerClientOrderId: v.optional(v.string()),
        providerOrderAliases: v.optional(v.array(v.string())),
        submitAttemptId: v.optional(v.string()),
        submitAttemptSequence: v.optional(v.number()),
        runId: v.optional(v.id("strategy_runs")),
        venue: v.optional(v.string()),
        signedOrderFingerprint: v.optional(v.string()),
        recoveryProbeEvidence: v.optional(v.any()),
        blocked: v.boolean(),
        occurredAt: v.number(),
        resolvedAt: v.optional(v.number()),
        resolutionNote: v.optional(v.string()),
    })
        .index("by_strategy", ["strategyId"])
        .index("by_strategy_blocked", ["strategyId", "blocked"])
        .index("by_app_blocked", ["app", "blocked"]),

    manual_run_requests: defineTable({
        strategyId: v.id("strategies"),
        app: venueAppV,
        requestedAt: v.number(),
        claimedBy: v.optional(v.string()),
        leaseExpiresAt: v.optional(v.number()),
        attemptCount: v.number(),
        lastError: v.optional(v.string()),
        terminalAt: v.optional(v.number()),
    })
        .index("by_app", ["app"])
        .index("by_strategy", ["strategyId"])
        .index("by_app_terminal_requested_at", ["app", "terminalAt", "requestedAt"])
        .index("by_strategy_terminal", ["strategyId", "terminalAt"])
        .index("by_app_lease_expires_at", ["app", "leaseExpiresAt"]),
})

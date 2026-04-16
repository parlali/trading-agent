import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"
import { authTables } from "@convex-dev/auth/server"
import {
    venueAppV,
    appV,
    orderStatusV,
    orderActionV,
    orderTransitionTypeV,
    severityV,
    eventTypeV,
    claimSourceV,
    portfolioProviderStatusV,
    providerOwnershipStatusV,
} from "./lib/validators"

export default defineSchema({
    ...authTables,

    strategies: defineTable({
        app: venueAppV,
        name: v.string(),
        enabled: v.boolean(),
        schedule: v.string(), // cron expression
        policy: v.any(), // typed per app, validated at runtime with zod
        context: v.string(), // freeform LLM prompt context
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
    })
        .index("by_strategy", ["strategyId"])
        .index("by_strategy_status", ["strategyId", "status"])
        .index("by_status_started_at", ["status", "startedAt"]),

    agent_logs: defineTable({
        runId: v.id("strategy_runs"),
        strategyId: v.id("strategies"),
        sequence: v.number(),
        role: v.union(
            v.literal("system"),
            v.literal("user"),
            v.literal("assistant"),
            v.literal("tool")
        ),
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
        payload: v.string(), // JSON stringified event data
        timestamp: v.number(),
    })
        .index("by_run", ["runId"])
        .index("by_strategy", ["strategyId"])
        .index("by_app_timestamp", ["app", "timestamp"]),

    orders: defineTable({
        orderId: v.string(),
        runId: v.id("strategy_runs"),
        strategyId: v.id("strategies"),
        app: v.optional(venueAppV),
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
        polling: v.object({
            pollIntervalMs: v.number(),
            timeoutMs: v.number(),
            startedAt: v.number(),
            lastCheckedAt: v.number(),
            nextCheckAt: v.optional(v.number()),
            timedOutAt: v.optional(v.number()),
            lastError: v.optional(v.string()),
            resumeToken: v.optional(v.string()),
        }),
    })
        .index("by_order_id", ["orderId"])
        .index("by_strategy_status", ["strategyId", "status"])
        .index("by_app_status", ["app", "status"])
        .index("by_run", ["runId"]),

    order_transitions: defineTable({
        orderId: v.string(),
        runId: v.id("strategy_runs"),
        strategyId: v.id("strategies"),
        sequence: v.number(),
        type: orderTransitionTypeV,
        status: orderStatusV,
        previousStatus: v.optional(orderStatusV),
        reason: v.optional(v.string()),
        details: v.optional(v.any()),
        timestamp: v.number(),
    })
        .index("by_order_sequence", ["orderId", "sequence"])
        .index("by_run", ["runId"]),

    positions: defineTable({
        strategyId: v.id("strategies"),
        app: venueAppV,
        instrument: v.string(),
        side: v.union(v.literal("long"), v.literal("short")),
        quantity: v.number(),
        entryPrice: v.number(),
        currentPrice: v.optional(v.number()),
        unrealizedPnl: v.optional(v.number()),
        metadata: v.optional(v.string()), // JSON stringified extra data (legs, etc.)
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
        app: appV,
        status: v.union(
            v.literal("healthy"),
            v.literal("degraded"),
            v.literal("unhealthy")
        ),
        lastHeartbeat: v.number(),
        metadata: v.optional(v.any()),
    }).index("by_app", ["app"]),

    app_heartbeat_liveness: defineTable({
        app: appV,
        status: v.union(
            v.literal("healthy"),
            v.literal("degraded"),
            v.literal("unhealthy")
        ),
        lastHeartbeat: v.number(),
        metadata: v.optional(v.any()),
        updatedAt: v.number(),
    }).index("by_app", ["app"]),

    app_heartbeat_snapshots: defineTable({
        app: appV,
        status: v.union(
            v.literal("healthy"),
            v.literal("degraded"),
            v.literal("unhealthy")
        ),
        metadata: v.optional(v.any()),
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
        balance: v.number(),
        equity: v.optional(v.number()),
        buyingPower: v.number(),
        marginUsed: v.number(),
        marginAvailable: v.number(),
        openPnl: v.number(),
        dayPnl: v.number(),
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
        strategyId: v.optional(v.id("strategies")),
        ownershipStatus: providerOwnershipStatusV,
        instrument: v.string(),
        side: v.union(v.literal("long"), v.literal("short")),
        quantity: v.number(),
        entryPrice: v.number(),
        currentPrice: v.optional(v.number()),
        unrealizedPnl: v.optional(v.number()),
        stopLoss: v.optional(v.number()),
        takeProfit: v.optional(v.number()),
        metadata: v.optional(v.string()),
        syncedAt: v.number(),
    })
        .index("by_app", ["app"])
        .index("by_app_strategy", ["app", "strategyId"]),

    provider_working_orders: defineTable({
        app: venueAppV,
        orderId: v.string(),
        strategyId: v.optional(v.id("strategies")),
        runId: v.optional(v.id("strategy_runs")),
        ownershipStatus: providerOwnershipStatusV,
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
        syncedAt: v.number(),
    })
        .index("by_app", ["app"])
        .index("by_app_strategy", ["app", "strategyId"])
        .index("by_app_status", ["app", "status"]),

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

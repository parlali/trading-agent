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
        .index("by_strategy_status", ["strategyId", "status"]),

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
        eventType: eventTypeV,
        payload: v.string(), // JSON stringified event data
        timestamp: v.number(),
    })
        .index("by_run", ["runId"])
        .index("by_strategy", ["strategyId"]),

    orders: defineTable({
        orderId: v.string(),
        runId: v.id("strategy_runs"),
        strategyId: v.id("strategies"),
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
            binance_futures: v.boolean(),
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

    account_snapshots: defineTable({
        app: appV,
        venue: v.string(),
        balance: v.number(),
        buyingPower: v.number(),
        marginUsed: v.number(),
        marginAvailable: v.number(),
        openPnl: v.number(),
        dayPnl: v.number(),
        timestamp: v.number(),
    })
        .index("by_app", ["app"])
        .index("by_app_timestamp", ["app", "timestamp"]),

    manual_run_requests: defineTable({
        strategyId: v.id("strategies"),
        app: venueAppV,
        requestedAt: v.number(),
    })
        .index("by_app", ["app"])
        .index("by_strategy", ["strategyId"]),
})

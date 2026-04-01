import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"
import { authTables } from "@convex-dev/auth/server"

export default defineSchema({
    ...authTables,

    strategies: defineTable({
        app: v.union(
            v.literal("alpaca-options"),
            v.literal("polymarket"),
            v.literal("mt5")
        ),
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
        app: v.union(
            v.literal("alpaca-options"),
            v.literal("polymarket"),
            v.literal("mt5")
        ),
        status: v.union(
            v.literal("running"),
            v.literal("completed"),
            v.literal("failed")
        ),
        startedAt: v.number(),
        endedAt: v.optional(v.number()),
        summary: v.optional(v.string()),
        error: v.optional(v.string()),
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
        eventType: v.union(
            v.literal("intent"),
            v.literal("validation"),
            v.literal("submission"),
            v.literal("fill_update"),
            v.literal("filled"),
            v.literal("rejected"),
            v.literal("cancelled")
        ),
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
        status: v.union(
            v.literal("pending"),
            v.literal("partially_filled"),
            v.literal("filled"),
            v.literal("rejected"),
            v.literal("cancelled"),
            v.literal("expired"),
            v.literal("timed_out")
        ),
        action: v.union(
            v.literal("entry"),
            v.literal("adjustment"),
            v.literal("close"),
            v.literal("modify"),
            v.literal("cancel")
        ),
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
        type: v.union(
            v.literal("submission"),
            v.literal("status_change"),
            v.literal("modify_attempt"),
            v.literal("cancel_attempt"),
            v.literal("timeout_decision"),
            v.literal("terminal")
        ),
        status: v.union(
            v.literal("pending"),
            v.literal("partially_filled"),
            v.literal("filled"),
            v.literal("rejected"),
            v.literal("cancelled"),
            v.literal("expired"),
            v.literal("timed_out")
        ),
        previousStatus: v.optional(
            v.union(
                v.literal("pending"),
                v.literal("partially_filled"),
                v.literal("filled"),
                v.literal("rejected"),
                v.literal("cancelled"),
                v.literal("expired"),
                v.literal("timed_out")
            )
        ),
        reason: v.optional(v.string()),
        details: v.optional(v.any()),
        timestamp: v.number(),
    })
        .index("by_order_sequence", ["orderId", "sequence"])
        .index("by_run", ["runId"]),

    positions: defineTable({
        strategyId: v.id("strategies"),
        app: v.union(
            v.literal("alpaca-options"),
            v.literal("polymarket"),
            v.literal("mt5")
        ),
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
        app: v.union(
            v.literal("alpaca-options"),
            v.literal("polymarket"),
            v.literal("mt5")
        ),
        instrument: v.string(),
        source: v.union(
            v.literal("position"),
            v.literal("order")
        ),
        sourceId: v.string(),
        updatedAt: v.number(),
    })
        .index("by_strategy", ["strategyId"])
        .index("by_strategy_source", ["strategyId", "source"])
        .index("by_strategy_source_source_id", ["strategyId", "source", "sourceId"])
        .index("by_app", ["app"]),

    position_syncs: defineTable({
        strategyId: v.id("strategies"),
        app: v.union(
            v.literal("alpaca-options"),
            v.literal("polymarket"),
            v.literal("mt5")
        ),
        syncedAt: v.number(),
        positionCount: v.number(),
    })
        .index("by_strategy_synced_at", ["strategyId", "syncedAt"])
        .index("by_app", ["app"]),

    alerts: defineTable({
        strategyId: v.optional(v.id("strategies")),
        app: v.optional(
            v.union(
                v.literal("alpaca-options"),
                v.literal("polymarket"),
                v.literal("mt5"),
                v.literal("backend")
            )
        ),
        severity: v.union(
            v.literal("critical"),
            v.literal("warning"),
            v.literal("info")
        ),
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
        }),
        updatedAt: v.number(),
        updatedBy: v.optional(v.string()),
    }).index("by_key", ["key"]),

    app_heartbeats: defineTable({
        app: v.union(
            v.literal("alpaca-options"),
            v.literal("polymarket"),
            v.literal("mt5"),
            v.literal("backend")
        ),
        status: v.union(
            v.literal("healthy"),
            v.literal("degraded"),
            v.literal("unhealthy")
        ),
        lastHeartbeat: v.number(),
        metadata: v.optional(v.any()),
    }).index("by_app", ["app"]),

    account_snapshots: defineTable({
        app: v.union(
            v.literal("alpaca-options"),
            v.literal("polymarket"),
            v.literal("mt5"),
            v.literal("backend")
        ),
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
        app: v.union(
            v.literal("alpaca-options"),
            v.literal("polymarket"),
            v.literal("mt5")
        ),
        requestedAt: v.number(),
    })
        .index("by_app", ["app"])
        .index("by_strategy", ["strategyId"]),
})

import { mutation } from "./_generated/server"
import { v } from "convex/values"
import { requireUser, requireServiceToken } from "./lib/authGuards"
import {
    reconcileOrderInstrumentClaim,
    replacePositionClaims,
} from "./lib/instrumentClaims"

// Create a new run record for a strategy, returns the run ID
export const createRun = mutation({
    args: {
        serviceToken: v.string(),
        strategyId: v.id("strategies"),
        app: v.union(
            v.literal("alpaca-options"),
            v.literal("polymarket"),
            v.literal("mt5")
        ),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        return await ctx.db.insert("strategy_runs", {
            strategyId: args.strategyId,
            app: args.app,
            status: "running",
            startedAt: Date.now(),
        })
    },
})

// Update run status (and optionally summary/error/endedAt)
export const updateRun = mutation({
    args: {
        serviceToken: v.string(),
        runId: v.id("strategy_runs"),
        status: v.union(
            v.literal("running"),
            v.literal("completed"),
            v.literal("failed")
        ),
        summary: v.optional(v.string()),
        error: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        const patch: Record<string, unknown> = { status: args.status }
        if (args.summary !== undefined) patch.summary = args.summary
        if (args.error !== undefined) patch.error = args.error
        if (args.status === "completed" || args.status === "failed") {
            patch.endedAt = Date.now()
        }
        await ctx.db.patch(args.runId, patch)
    },
})

// Append a message to the agent reasoning trace
export const logAgentMessage = mutation({
    args: {
        serviceToken: v.string(),
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
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        await ctx.db.insert("agent_logs", {
            runId: args.runId,
            strategyId: args.strategyId,
            sequence: args.sequence,
            role: args.role,
            content: args.content,
            toolName: args.toolName,
            toolInput: args.toolInput,
            toolOutput: args.toolOutput,
            timestamp: Date.now(),
        })
    },
})

// Append a trade lifecycle event
export const logTradeEvent = mutation({
    args: {
        serviceToken: v.string(),
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
        payload: v.string(),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        await ctx.db.insert("trade_events", {
            runId: args.runId,
            strategyId: args.strategyId,
            eventType: args.eventType,
            payload: args.payload,
            timestamp: Date.now(),
        })
    },
})

export const upsertOrder = mutation({
    args: {
        serviceToken: v.string(),
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
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        const strategy = await ctx.db.get(args.strategyId)
        if (!strategy) {
            throw new Error(`Strategy not found: ${args.strategyId}`)
        }

        const existing = await ctx.db
            .query("orders")
            .withIndex("by_order_id", (q) => q.eq("orderId", args.orderId))
            .first()

        const payload = {
            orderId: args.orderId,
            runId: args.runId,
            strategyId: args.strategyId,
            venue: args.venue,
            instrument: args.instrument,
            status: args.status,
            action: args.action,
            quantity: args.quantity,
            filledQuantity: args.filledQuantity,
            remainingQuantity: args.remainingQuantity,
            avgFillPrice: args.avgFillPrice,
            submittedAt: args.submittedAt,
            updatedAt: args.updatedAt,
            intent: args.intent,
            metadata: args.metadata,
            polling: args.polling,
        }

        if (existing) {
            await ctx.db.patch(existing._id, payload)
            await reconcileOrderInstrumentClaim(ctx, {
                strategyId: args.strategyId,
                app: strategy.app,
                orderId: args.orderId,
                instrument: args.instrument,
                action: args.action,
                status: args.status,
                updatedAt: args.updatedAt,
            })
            return existing._id
        }

        const orderDocId = await ctx.db.insert("orders", payload)
        await reconcileOrderInstrumentClaim(ctx, {
            strategyId: args.strategyId,
            app: strategy.app,
            orderId: args.orderId,
            instrument: args.instrument,
            action: args.action,
            status: args.status,
            updatedAt: args.updatedAt,
        })
        return orderDocId
    },
})

export const logOrderTransition = mutation({
    args: {
        serviceToken: v.string(),
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
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        await ctx.db.insert("order_transitions", {
            orderId: args.orderId,
            runId: args.runId,
            strategyId: args.strategyId,
            sequence: args.sequence,
            type: args.type,
            status: args.status,
            previousStatus: args.previousStatus,
            reason: args.reason,
            details: args.details,
            timestamp: args.timestamp,
        })
    },
})

// Replace position snapshot for a strategy (delete old, insert new)
export const syncPositions = mutation({
    args: {
        serviceToken: v.string(),
        strategyId: v.id("strategies"),
        app: v.union(
            v.literal("alpaca-options"),
            v.literal("polymarket"),
            v.literal("mt5")
        ),
        positions: v.array(
            v.object({
                instrument: v.string(),
                side: v.union(v.literal("long"), v.literal("short")),
                quantity: v.number(),
                entryPrice: v.number(),
                currentPrice: v.optional(v.number()),
                unrealizedPnl: v.optional(v.number()),
                metadata: v.optional(v.string()),
            })
        ),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        const now = Date.now()
        await ctx.db.insert("position_syncs", {
            strategyId: args.strategyId,
            app: args.app,
            syncedAt: now,
            positionCount: args.positions.length,
        })

        for (const pos of args.positions) {
            await ctx.db.insert("positions", {
                strategyId: args.strategyId,
                app: args.app,
                instrument: pos.instrument,
                side: pos.side,
                quantity: pos.quantity,
                entryPrice: pos.entryPrice,
                currentPrice: pos.currentPrice,
                unrealizedPnl: pos.unrealizedPnl,
                metadata: pos.metadata,
                syncedAt: now,
            })
        }

        await replacePositionClaims(ctx, {
            strategyId: args.strategyId,
            app: args.app,
            instruments: args.positions.map((position) => position.instrument),
            updatedAt: now,
        })
    },
})

export const triggerManualRun = mutation({
    args: {
        strategyId: v.id("strategies"),
    },
    handler: async (ctx, args) => {
        await requireUser(ctx)
        const strategy = await ctx.db.get(args.strategyId)

        if (!strategy) {
            throw new Error(`Strategy not found: ${args.strategyId}`)
        }

        const existing = await ctx.db
            .query("manual_run_requests")
            .withIndex("by_strategy", (q) => q.eq("strategyId", args.strategyId))
            .first()

        if (existing) {
            return existing._id
        }

        return await ctx.db.insert("manual_run_requests", {
            strategyId: args.strategyId,
            app: strategy.app,
            requestedAt: Date.now(),
        })
    },
})

// Create a new alert
export const createAlert = mutation({
    args: {
        serviceToken: v.string(),
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
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        await ctx.db.insert("alerts", {
            strategyId: args.strategyId,
            app: args.app,
            severity: args.severity,
            message: args.message,
            acknowledged: false,
            timestamp: Date.now(),
        })
    },
})

export const acknowledgeAlert = mutation({
    args: {
        alertId: v.id("alerts"),
    },
    handler: async (ctx, args) => {
        await requireUser(ctx)
        await ctx.db.patch(args.alertId, {
            acknowledged: true,
        })
    },
})

// Create or update a strategy config
export const upsertStrategy = mutation({
    args: {
        id: v.optional(v.id("strategies")),
        app: v.union(
            v.literal("alpaca-options"),
            v.literal("polymarket"),
            v.literal("mt5")
        ),
        name: v.string(),
        enabled: v.boolean(),
        schedule: v.string(),
        policy: v.any(),
        context: v.string(),
    },
    handler: async (ctx, args) => {
        await requireUser(ctx)
        const now = Date.now()
        if (args.id) {
            await ctx.db.patch(args.id, {
                app: args.app,
                name: args.name,
                enabled: args.enabled,
                schedule: args.schedule,
                policy: args.policy,
                context: args.context,
                updatedAt: now,
            })
            return args.id
        }
        return await ctx.db.insert("strategies", {
            app: args.app,
            name: args.name,
            enabled: args.enabled,
            schedule: args.schedule,
            policy: args.policy,
            context: args.context,
            createdAt: now,
            updatedAt: now,
        })
    },
})

// Disable a strategy (set enabled = false)
export const disableStrategy = mutation({
    args: { strategyId: v.id("strategies") },
    handler: async (ctx, args) => {
        await requireUser(ctx)
        await ctx.db.patch(args.strategyId, { enabled: false })
    },
})

// Delete a strategy permanently
export const deleteStrategy = mutation({
    args: { strategyId: v.id("strategies") },
    handler: async (ctx, args) => {
        await requireUser(ctx)
        const strategy = await ctx.db.get(args.strategyId)
        if (!strategy) {
            throw new Error(`Strategy not found: ${args.strategyId}`)
        }

        const activeRun = await ctx.db
            .query("strategy_runs")
            .withIndex("by_strategy_status", (q) =>
                q.eq("strategyId", args.strategyId).eq("status", "running")
            )
            .first()

        if (activeRun) {
            throw new Error("Cannot delete a strategy with an active run")
        }

        await ctx.db.delete(args.strategyId)
    },
})

// Report heartbeat from an app
export const reportHeartbeat = mutation({
    args: {
        serviceToken: v.string(),
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
        metadata: v.optional(v.any()),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        const existing = await ctx.db
            .query("app_heartbeats")
            .withIndex("by_app", (q) => q.eq("app", args.app))
            .first()

        const payload = {
            app: args.app,
            status: args.status,
            lastHeartbeat: Date.now(),
            metadata: args.metadata,
        }

        if (existing) {
            await ctx.db.patch(existing._id, payload)
            return existing._id
        }

        return await ctx.db.insert("app_heartbeats", payload)
    },
})

// Snapshot account state from an app
export const snapshotAccountState = mutation({
    args: {
        serviceToken: v.string(),
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
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        return await ctx.db.insert("account_snapshots", {
            app: args.app,
            venue: args.venue,
            balance: args.balance,
            buyingPower: args.buyingPower,
            marginUsed: args.marginUsed,
            marginAvailable: args.marginAvailable,
            openPnl: args.openPnl,
            dayPnl: args.dayPnl,
            timestamp: Date.now(),
        })
    },
})

// Set kill switch state (global or per-app)
export const setKillSwitch = mutation({
    args: {
        scope: v.union(
            v.literal("global"),
            v.literal("alpaca-options"),
            v.literal("polymarket"),
            v.literal("mt5")
        ),
        enabled: v.boolean(),
        updatedBy: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        await requireUser(ctx)
        const existing = await ctx.db
            .query("system_state")
            .withIndex("by_key", (q) => q.eq("key", "kill_switches"))
            .first()

        const now = Date.now()

        if (!existing) {
            const state = {
                key: "kill_switches" as const,
                globalKillSwitch: args.scope === "global" ? args.enabled : false,
                appKillSwitches: {
                    alpaca_options: args.scope === "alpaca-options" ? args.enabled : false,
                    polymarket: args.scope === "polymarket" ? args.enabled : false,
                    mt5: args.scope === "mt5" ? args.enabled : false,
                },
                updatedAt: now,
                updatedBy: args.updatedBy,
            }
            return await ctx.db.insert("system_state", state)
        }

        if (args.scope === "global") {
            await ctx.db.patch(existing._id, {
                globalKillSwitch: args.enabled,
                updatedAt: now,
                updatedBy: args.updatedBy,
            })
        } else {
            const killSwitchKey = args.scope === "alpaca-options" ? "alpaca_options" : args.scope
            await ctx.db.patch(existing._id, {
                appKillSwitches: {
                    ...existing.appKillSwitches,
                    [killSwitchKey]: args.enabled,
                },
                updatedAt: now,
                updatedBy: args.updatedBy,
            })
        }

        return existing._id
    },
})

export const clearManualRunRequest = mutation({
    args: {
        serviceToken: v.string(),
        requestId: v.id("manual_run_requests"),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        await ctx.db.delete(args.requestId)
    },
})

import { mutation } from "../../_generated/server"
import type { DatabaseWriter } from "../../_generated/server"
import type { Id } from "../../_generated/dataModel"
import { v } from "convex/values"
import { requireServiceToken } from "../authGuards"
import { reconcileOrderInstrumentClaim } from "../instrumentClaims"

export const createRun = mutation({
    args: {
        serviceToken: v.string(),
        strategyId: v.id("strategies"),
        app: v.union(
            v.literal("alpaca-options"),
            v.literal("polymarket"),
            v.literal("mt5")
        ),
        trigger: v.optional(v.union(
            v.literal("cron"),
            v.literal("manual"),
            v.literal("callback")
        )),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        return await ctx.db.insert("strategy_runs", {
            strategyId: args.strategyId,
            app: args.app,
            status: "running",
            trigger: args.trigger ?? "cron",
            startedAt: Date.now(),
        })
    },
})

export const recordRunCallback = mutation({
    args: {
        serviceToken: v.string(),
        runId: v.id("strategy_runs"),
        callbackRequestedMinutes: v.number(),
        callbackFiresAt: v.number(),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        await ctx.db.patch(args.runId, {
            callbackRequestedMinutes: args.callbackRequestedMinutes,
            callbackFiresAt: args.callbackFiresAt,
        })
    },
})

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

import { mutation } from "../../_generated/server"
import type { DatabaseWriter } from "../../_generated/server"
import type { Doc, Id } from "../../_generated/dataModel"
import { v } from "convex/values"
import { DEFAULT_STALE_RUN_TIMEOUT_MS, type ExecutionCommitOutcome } from "@valiq-trading/core"
import { requireServiceToken } from "../authGuards"
import { getClaimInstrumentsForOrder, reconcileOrderInstrumentClaim } from "../instrumentClaims"
import { incrementControlPlaneMetric } from "../controlPlaneMetrics"
import {
    agentLogRoleV,
    eventTypeV,
    orderCoreFieldsV,
    orderTransitionCoreFieldsV,
    runSystemContextDigestV,
    venueAppV,
} from "../validators"
import { findOrderRowByIdentity } from "../orderIdentityLookup"

export const createRun = mutation({
    args: {
        serviceToken: v.string(),
        strategyId: v.id("strategies"),
        app: venueAppV,
        trigger: v.optional(v.union(
            v.literal("cron"),
            v.literal("manual"),
            v.literal("callback")
        )),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        const activeRuns = await ctx.db
            .query("strategy_runs")
            .withIndex("by_strategy_status", (q) =>
                q.eq("strategyId", args.strategyId).eq("status", "running")
            )
            .collect()

        const now = Date.now()
        const freshActiveRun = activeRuns.find((run) => now - run.startedAt <= DEFAULT_STALE_RUN_TIMEOUT_MS)

        for (const run of activeRuns) {
            if (now - run.startedAt <= DEFAULT_STALE_RUN_TIMEOUT_MS) {
                continue
            }

            await ctx.db.patch(run._id, {
                status: "failed",
                error: "Recovered stale running record automatically before creating a new run",
                endedAt: now,
            })
        }

        if (freshActiveRun) {
            throw new Error(
                `Strategy ${args.strategyId} already has an active run (${freshActiveRun._id})`
            )
        }

        return await ctx.db.insert("strategy_runs", {
            strategyId: args.strategyId,
            app: args.app,
            status: "running",
            trigger: args.trigger ?? "cron",
            startedAt: Date.now(),
        })
    },
})

export const recoverStaleRunningRuns = mutation({
    args: {
        serviceToken: v.string(),
        olderThanMs: v.optional(v.number()),
        maxBatch: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)

        const olderThanMs = args.olderThanMs ?? DEFAULT_STALE_RUN_TIMEOUT_MS
        const endedAt = Date.now()
        const staleBefore = endedAt - olderThanMs
        const maxBatch = Math.max(1, Math.min(args.maxBatch ?? 500, 5_000))
        const runningRuns = await ctx.db
            .query("strategy_runs")
            .withIndex("by_status_started_at", (q) =>
                q.eq("status", "running").lt("startedAt", staleBefore)
            )
            .take(maxBatch)
        let recovered = 0

        for (const run of runningRuns) {
            await ctx.db.patch(run._id, {
                status: "failed",
                error: "Recovered stale running record during periodic recovery",
                endedAt,
            })
            recovered++
        }

        await incrementControlPlaneMetric(ctx, {
            metric: "recover_stale_running_runs.candidates",
            delta: runningRuns.length,
        })
        await incrementControlPlaneMetric(ctx, {
            metric: "recover_stale_running_runs.recovered",
            delta: recovered,
        })

        return { recovered }
    },
})

export const recoverRunningRuns = mutation({
    args: {
        serviceToken: v.string(),
        maxBatch: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)

        const maxBatch = Math.max(1, Math.min(args.maxBatch ?? 5_000, 10_000))
        const runningRuns = await ctx.db
            .query("strategy_runs")
            .withIndex("by_status_started_at", (q) => q.eq("status", "running"))
            .order("asc")
            .take(maxBatch)

        const endedAt = Date.now()

        for (const run of runningRuns) {
            await ctx.db.patch(run._id, {
                status: "failed",
                error: "Recovered on backend startup after an interrupted run",
                endedAt,
            })
        }

        await incrementControlPlaneMetric(ctx, {
            metric: "recover_running_runs.recovered",
            delta: runningRuns.length,
        })

        return {
            recovered: runningRuns.length,
        }
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

export const runDiagnosticsV = v.object({
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

const RUN_DIAGNOSTIC_PATCH_FIELDS = [
    "degradedResearch",
    "degradedReason",
    "toolFailureCount",
    "toolRetryCount",
    "decisionUnderDegradedContext",
    "promptTokens",
    "completionTokens",
    "reasoningTokens",
    "llmCost",
    "llmProvider",
    "llmModel",
    "llmAuthMode",
    "llmBillingMode",
    "llmResponseIds",
    "codexThreadId",
    "codexTurnIds",
    "llmRateLimitSnapshotBefore",
    "llmRateLimitSnapshotAfter",
    "openRouterResponseIds",
    "opportunityResearched",
    "opportunityQualified",
    "opportunityRejectedByModel",
    "opportunityRejectedByRisk",
    "opportunitySubmitted",
    "opportunityFilled",
    "opportunityClosed",
    "opportunityRealizedPnl",
    "systemContextDigest",
] as const

export function buildRunDiagnosticsPatch(
    diagnostics: Record<string, unknown>
): Record<string, unknown> {
    const patch: Record<string, unknown> = {}

    for (const field of RUN_DIAGNOSTIC_PATCH_FIELDS) {
        if (diagnostics[field] !== undefined) {
            patch[field] = diagnostics[field]
        }
    }

    return patch
}

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
        diagnostics: v.optional(runDiagnosticsV),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        const patch: Record<string, unknown> = { status: args.status }
        if (args.summary !== undefined) patch.summary = args.summary
        if (args.error !== undefined) patch.error = args.error
        if (args.diagnostics) {
            Object.assign(patch, buildRunDiagnosticsPatch(args.diagnostics))
        }
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
        role: agentLogRoleV,
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
        eventType: eventTypeV,
        payload: v.string(),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        const strategy = await ctx.db.get(args.strategyId)
        await ctx.db.insert("trade_events", {
            runId: args.runId,
            strategyId: args.strategyId,
            app: strategy?.app,
            eventType: args.eventType,
            payload: args.payload,
            timestamp: Date.now(),
        })
    },
})

export const upsertOrder = mutation({
    args: {
        serviceToken: v.string(),
        ...orderCoreFieldsV,
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        return await upsertOrderRow(ctx, args)
    },
})

export const logOrderTransition = mutation({
    args: {
        serviceToken: v.string(),
        ...orderTransitionCoreFieldsV,
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        return await appendOrderTransition(ctx, args)
    },
})

type UpsertOrderArgs = {
    orderId: string
    canonicalOrderId?: string
    providerOrderId: string
    providerClientOrderId?: string
    providerOrderAliases?: string[]
    submitAttemptId?: string
    submitAttemptSequence?: number
    commitOutcome?: ExecutionCommitOutcome
    signedOrderFingerprint?: string
    signedOrderMetadata?: unknown
    runId: Id<"strategy_runs">
    strategyId: Id<"strategies">
    venue: string
    instrument: string
    status: Doc<"orders">["status"]
    action: Doc<"orders">["action"]
    quantity: number
    filledQuantity: number
    remainingQuantity: number
    avgFillPrice?: number
    submittedAt: number
    updatedAt: number
    intent: unknown
    metadata?: unknown
    lastTransitionSequence: number
    polling: Doc<"orders">["polling"]
}

type OrderTransitionInsertArgs = {
    orderId: string
    runId: Id<"strategy_runs">
    strategyId: Id<"strategies">
    type: Doc<"order_transitions">["type"]
    status: Doc<"order_transitions">["status"]
    previousStatus?: Doc<"order_transitions">["previousStatus"]
    reason?: string
    details?: unknown
    timestamp: number
}

export async function upsertOrderRow(
    ctx: { db: DatabaseWriter },
    args: UpsertOrderArgs
): Promise<Id<"orders">> {
    const strategy = await ctx.db.get(args.strategyId)
    if (!strategy) {
        throw new Error(`Strategy not found: ${args.strategyId}`)
    }

    const existing = await findOrderRowByIdentity(ctx.db, args.orderId)
    const payload = {
        orderId: args.orderId,
        canonicalOrderId: args.canonicalOrderId ?? args.orderId,
        providerOrderId: args.providerOrderId,
        providerClientOrderId: args.providerClientOrderId,
        providerOrderAliases: mergeOrderAliases(existing, args),
        submitAttemptId: args.submitAttemptId,
        submitAttemptSequence: args.submitAttemptSequence,
        commitOutcome: args.commitOutcome ?? "accepted",
        signedOrderFingerprint: args.signedOrderFingerprint,
        signedOrderMetadata: args.signedOrderMetadata,
        runId: args.runId,
        strategyId: args.strategyId,
        app: strategy.app,
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
        lastTransitionSequence: Math.max(existing?.lastTransitionSequence ?? 0, args.lastTransitionSequence),
        polling: args.polling,
    }

    if (existing) {
        await ctx.db.patch(existing._id, payload)
        await reconcileOrderInstrumentClaim(ctx, {
            strategyId: args.strategyId,
            app: strategy.app,
            orderId: args.orderId,
            instrument: args.instrument,
            claimInstruments: getClaimInstrumentsForOrder(args.instrument, args.intent),
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
        claimInstruments: getClaimInstrumentsForOrder(args.instrument, args.intent),
        action: args.action,
        status: args.status,
        updatedAt: args.updatedAt,
    })
    return orderDocId
}

export async function appendOrderTransition(
    ctx: { db: DatabaseWriter },
    args: OrderTransitionInsertArgs
): Promise<number> {
    const order = await findOrderRowByIdentity(ctx.db, args.orderId)
    if (!order) {
        throw new Error(`Cannot append transition for unknown order ${args.orderId}`)
    }

    const sequence = order.lastTransitionSequence + 1
    await ctx.db.patch(order._id, {
        lastTransitionSequence: sequence,
    })
    await ctx.db.insert("order_transitions", {
        orderId: order.orderId,
        runId: args.runId,
        strategyId: args.strategyId,
        sequence,
        type: args.type,
        status: args.status,
        previousStatus: args.previousStatus,
        reason: args.reason,
        details: args.details,
        timestamp: args.timestamp,
    })
    return sequence
}

function mergeOrderAliases(
    existing: Doc<"orders"> | null,
    args: Pick<UpsertOrderArgs, "orderId" | "providerOrderId" | "providerClientOrderId" | "providerOrderAliases">
): string[] {
    const aliases = new Set<string>([
        ...(existing?.providerOrderAliases ?? []),
        ...(args.providerOrderAliases ?? []),
    ])

    const existingProviderOrderId = existing?.providerOrderId
    if (
        existingProviderOrderId &&
        existingProviderOrderId !== args.orderId &&
        existingProviderOrderId !== args.providerOrderId
    ) {
        aliases.add(existingProviderOrderId)
    }

    aliases.delete(args.orderId)
    aliases.delete(args.providerOrderId)
    if (args.providerClientOrderId) {
        aliases.delete(args.providerClientOrderId)
    }

    return Array.from(aliases).sort((left, right) => left.localeCompare(right))
}

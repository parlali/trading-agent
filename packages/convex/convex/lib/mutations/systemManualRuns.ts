import { mutation, type MutationCtx } from "../../_generated/server"
import type { Doc, Id } from "../../_generated/dataModel"
import { v } from "convex/values"
import { requireServiceToken } from "../authGuards"
import { venueAppV } from "../validators"
import { incrementControlPlaneMetric } from "../controlPlaneMetrics"

const DEFAULT_MANUAL_RUN_LEASE_MS = 30_000
const MAX_MANUAL_RUN_LEASE_MS = 5 * 60 * 1000
const DEFAULT_MANUAL_RUN_CLAIM_LIMIT = 25
const MAX_MANUAL_RUN_CLAIM_LIMIT = 100
const DEFAULT_MANUAL_RUN_MAX_ATTEMPTS = 5
const MAX_MANUAL_RUN_MAX_ATTEMPTS = 20

const manualRunOutcomeV = v.union(
    v.literal("completed"),
    v.literal("requeue"),
    v.literal("retryable_failure"),
    v.literal("terminal_failure")
)

export async function enqueueManualRunRequest(
    ctx: Pick<MutationCtx, "db">,
    args: {
        strategyId: Id<"strategies">
        requireEnabled: boolean
    }
): Promise<Id<"manual_run_requests">> {
    const strategy = await ctx.db.get(args.strategyId)

    if (!strategy) {
        throw new Error(`Strategy not found: ${args.strategyId}`)
    }

    if (args.requireEnabled && !strategy.enabled) {
        throw new Error(`Strategy is disabled: ${args.strategyId}`)
    }

    const existing = await ctx.db
        .query("manual_run_requests")
        .withIndex("by_strategy_terminal", (q) =>
            q.eq("strategyId", args.strategyId).eq("terminalAt", undefined)
        )
        .first()

    if (existing) {
        return existing._id
    }

    return await ctx.db.insert("manual_run_requests", {
        strategyId: args.strategyId,
        app: strategy.app,
        requestedAt: Date.now(),
        attemptCount: 0,
    })
}

function boundManualRunLeaseMs(value: number | undefined): number {
    return Math.max(1_000, Math.min(value ?? DEFAULT_MANUAL_RUN_LEASE_MS, MAX_MANUAL_RUN_LEASE_MS))
}

function boundManualRunClaimLimit(value: number | undefined): number {
    return Math.max(1, Math.min(value ?? DEFAULT_MANUAL_RUN_CLAIM_LIMIT, MAX_MANUAL_RUN_CLAIM_LIMIT))
}

function boundManualRunMaxAttempts(value: number | undefined): number {
    return Math.max(1, Math.min(value ?? DEFAULT_MANUAL_RUN_MAX_ATTEMPTS, MAX_MANUAL_RUN_MAX_ATTEMPTS))
}

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

export const triggerManualRunAsService = mutation({
    args: {
        serviceToken: v.string(),
        strategyId: v.id("strategies"),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        return await enqueueManualRunRequest(ctx, {
            strategyId: args.strategyId,
            requireEnabled: true,
        })
    },
})

export const claimManualRunRequests = mutation({
    args: {
        serviceToken: v.string(),
        app: venueAppV,
        workerId: v.string(),
        leaseMs: v.optional(v.number()),
        maxClaims: v.optional(v.number()),
        maxAttempts: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)

        const now = Date.now()
        const leaseMs = boundManualRunLeaseMs(args.leaseMs)
        const maxClaims = boundManualRunClaimLimit(args.maxClaims)
        const maxAttempts = boundManualRunMaxAttempts(args.maxAttempts)

        const pending = await ctx.db
            .query("manual_run_requests")
            .withIndex("by_app_terminal_requested_at", (q) =>
                q.eq("app", args.app).eq("terminalAt", undefined)
            )
            .order("asc")
            .take(Math.max(maxClaims * 4, maxClaims))

        const claimed: Array<{
            _id: Id<"manual_run_requests">
            strategyId: Id<"strategies">
            app: Doc<"manual_run_requests">["app"]
            requestedAt: number
            attemptCount: number
            leaseExpiresAt: number
        }> = []

        let contentionCount = 0
        let terminalizedCount = 0

        for (const request of pending) {
            if (claimed.length >= maxClaims) {
                break
            }

            const leaseActive = request.leaseExpiresAt !== undefined && request.leaseExpiresAt > now
            if (request.claimedBy && request.claimedBy !== args.workerId && leaseActive) {
                contentionCount++
                continue
            }

            if (request.attemptCount >= maxAttempts) {
                await ctx.db.patch(request._id, {
                    claimedBy: undefined,
                    leaseExpiresAt: undefined,
                    terminalAt: now,
                    lastError: request.lastError ?? `Manual run request exceeded max attempts (${maxAttempts})`,
                })
                terminalizedCount++
                continue
            }

            const leaseExpiresAt = now + leaseMs

            await ctx.db.patch(request._id, {
                claimedBy: args.workerId,
                leaseExpiresAt,
            })

            claimed.push({
                _id: request._id,
                strategyId: request.strategyId,
                app: request.app,
                requestedAt: request.requestedAt,
                attemptCount: request.attemptCount,
                leaseExpiresAt,
            })
        }

        await incrementControlPlaneMetric(ctx, {
            metric: "manual_run.claim_attempt",
            app: args.app,
        })
        if (claimed.length > 0) {
            await incrementControlPlaneMetric(ctx, {
                metric: "manual_run.claimed",
                app: args.app,
                delta: claimed.length,
            })
        }
        if (contentionCount > 0) {
            await incrementControlPlaneMetric(ctx, {
                metric: "manual_run.claim_contention",
                app: args.app,
                delta: contentionCount,
            })
        }
        if (terminalizedCount > 0) {
            await incrementControlPlaneMetric(ctx, {
                metric: "manual_run.terminalized_on_claim",
                app: args.app,
                delta: terminalizedCount,
            })
        }

        return {
            app: args.app,
            claimed,
            contentionCount,
            terminalizedCount,
            maxAttempts,
            leaseMs,
        }
    },
})

export const ackManualRunRequest = mutation({
    args: {
        serviceToken: v.string(),
        requestId: v.id("manual_run_requests"),
        workerId: v.string(),
        outcome: manualRunOutcomeV,
        error: v.optional(v.string()),
        maxAttempts: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)

        const now = Date.now()
        const maxAttempts = boundManualRunMaxAttempts(args.maxAttempts)
        const request = await ctx.db.get(args.requestId)
        if (!request) {
            return { status: "missing" as const }
        }

        if (request.terminalAt) {
            return { status: "already_terminal" as const }
        }

        if (request.claimedBy !== args.workerId) {
            throw new Error(`Manual run request ${args.requestId} is not claimed by worker ${args.workerId}`)
        }

        if (args.outcome === "completed") {
            await ctx.db.delete(args.requestId)
            await incrementControlPlaneMetric(ctx, {
                metric: "manual_run.ack_completed",
                app: request.app,
            })
            return { status: "completed" as const }
        }

        if (args.outcome === "requeue") {
            await ctx.db.patch(args.requestId, {
                claimedBy: undefined,
                leaseExpiresAt: undefined,
                lastError: args.error ?? request.lastError,
            })
            await incrementControlPlaneMetric(ctx, {
                metric: "manual_run.ack_requeue",
                app: request.app,
            })
            return { status: "requeue" as const }
        }

        if (args.outcome === "terminal_failure") {
            await ctx.db.patch(args.requestId, {
                claimedBy: undefined,
                leaseExpiresAt: undefined,
                terminalAt: now,
                lastError: args.error ?? request.lastError ?? "Manual run request failed terminally",
            })
            await incrementControlPlaneMetric(ctx, {
                metric: "manual_run.ack_terminal_failure",
                app: request.app,
            })
            return { status: "terminal_failure" as const }
        }

        const nextAttemptCount = request.attemptCount + 1
        if (nextAttemptCount >= maxAttempts) {
            await ctx.db.patch(args.requestId, {
                claimedBy: undefined,
                leaseExpiresAt: undefined,
                attemptCount: nextAttemptCount,
                terminalAt: now,
                lastError: args.error ?? request.lastError ?? `Manual run request exceeded max attempts (${maxAttempts})`,
            })
            await incrementControlPlaneMetric(ctx, {
                metric: "manual_run.ack_terminal_failure",
                app: request.app,
            })
            return { status: "terminal_failure" as const }
        }

        await ctx.db.patch(args.requestId, {
            claimedBy: undefined,
            leaseExpiresAt: undefined,
            attemptCount: nextAttemptCount,
            lastError: args.error ?? request.lastError,
        })
        await incrementControlPlaneMetric(ctx, {
            metric: "manual_run.ack_retryable_failure",
            app: request.app,
        })

        return { status: "retryable_failure" as const }
    },
})

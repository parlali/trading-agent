import { query } from "../../_generated/server"
import { v } from "convex/values"
import { requireUser, requireServiceToken, requireUserOrServiceToken } from "../authGuards"
import {
    assertWithinRunEvidenceRowLimit,
    MAX_RUN_EVIDENCE_ROWS,
} from "./evidenceBounds"

const DEFAULT_RUN_HISTORY_LIMIT = 20
const MAX_RUN_HISTORY_LIMIT = 500

export const getRunHistory = query({
    args: {
        serviceToken: v.optional(v.string()),
        strategyId: v.id("strategies"),
        limit: v.optional(v.number()),
        beforeStartedAt: v.optional(v.number()),
        beforeCreationTime: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
        await requireUserOrServiceToken(ctx, args.serviceToken)
        const limit = resolveRunHistoryLimit(args.limit)
        if (args.beforeStartedAt === undefined) {
            return sortRunHistory(await ctx.db
                .query("strategy_runs")
                .withIndex("by_strategy_started_at", (q) => q.eq("strategyId", args.strategyId))
                .order("desc")
                .take(limit))
        }

        const sameTimestampRuns = args.beforeCreationTime === undefined
            ? []
            : await ctx.db
                .query("strategy_runs")
                .withIndex("by_strategy_started_at", (q) =>
                    q.eq("strategyId", args.strategyId).eq("startedAt", args.beforeStartedAt!)
                )
                .filter((q) => q.lt(q.field("_creationTime"), args.beforeCreationTime!))
                .order("desc")
                .take(limit)
        const remainingLimit = limit - sameTimestampRuns.length
        if (remainingLimit <= 0) {
            return sortRunHistory(sameTimestampRuns).slice(0, limit)
        }

        const olderRuns = await ctx.db
            .query("strategy_runs")
            .withIndex("by_strategy_started_at", (q) =>
                q.eq("strategyId", args.strategyId).lt("startedAt", args.beforeStartedAt!)
            )
            .order("desc")
            .take(remainingLimit)

        return sortRunHistory([
            ...sameTimestampRuns,
            ...olderRuns,
        ]).slice(0, limit)
    },
})

function sortRunHistory<T extends { startedAt: number; _creationTime?: number }>(runs: T[]): T[] {
    return [...runs].sort((left, right) => {
        const startedAt = right.startedAt - left.startedAt
        if (startedAt !== 0) {
            return startedAt
        }

        return (right._creationTime ?? 0) - (left._creationTime ?? 0)
    })
}

function resolveRunHistoryLimit(value: number | undefined): number {
    if (value === undefined) {
        return DEFAULT_RUN_HISTORY_LIMIT
    }
    if (!Number.isInteger(value) || value < 1) {
        throw new Error("getRunHistory limit must be a positive integer")
    }

    return Math.min(value, MAX_RUN_HISTORY_LIMIT)
}

export const getRunById = query({
    args: {
        serviceToken: v.optional(v.string()),
        runId: v.id("strategy_runs"),
    },
    handler: async (ctx, args) => {
        await requireUserOrServiceToken(ctx, args.serviceToken)
        return await ctx.db.get(args.runId)
    },
})

export const getLastCompletedRunSummary = query({
    args: {
        serviceToken: v.string(),
        strategyId: v.id("strategies"),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        const run = await ctx.db
            .query("strategy_runs")
            .withIndex("by_strategy_status", (q) =>
                q.eq("strategyId", args.strategyId).eq("status", "completed")
            )
            .order("desc")
            .first()
        if (!run?.summary) return null
        return {
            summary: run.summary,
            endedAt: run.endedAt ?? run.startedAt,
            systemContextDigest: run.systemContextDigest,
        }
    },
})

export const getActiveRun = query({
    args: {
        serviceToken: v.optional(v.string()),
        strategyId: v.id("strategies"),
    },
    handler: async (ctx, args) => {
        await requireUserOrServiceToken(ctx, args.serviceToken)
        return await ctx.db
            .query("strategy_runs")
            .withIndex("by_strategy_status", (q) =>
                q.eq("strategyId", args.strategyId).eq("status", "running")
            )
            .first()
    },
})

export const getAgentLogs = query({
    args: {
        serviceToken: v.optional(v.string()),
        runId: v.id("strategy_runs"),
    },
    handler: async (ctx, args) => {
        await requireUserOrServiceToken(ctx, args.serviceToken)
        const rows = await ctx.db
            .query("agent_logs")
            .withIndex("by_run_sequence", (q) => q.eq("runId", args.runId))
            .take(MAX_RUN_EVIDENCE_ROWS + 1)

        return assertWithinRunEvidenceRowLimit(rows, `agent logs for run ${args.runId}`)
    },
})

export const getScheduleOverview = query({
    args: {},
    handler: async (ctx) => {
        await requireUser(ctx)
        const strategies = await ctx.db.query("strategies").collect()

        const results = await Promise.all(
            strategies.map(async (strategy) => {
                const [latestRun, activeRun] = await Promise.all([
                    ctx.db
                        .query("strategy_runs")
                        .withIndex("by_strategy", (q) => q.eq("strategyId", strategy._id))
                        .order("desc")
                        .first(),
                    ctx.db
                        .query("strategy_runs")
                        .withIndex("by_strategy_status", (q) =>
                            q.eq("strategyId", strategy._id).eq("status", "running")
                        )
                        .first(),
                ])

                let pendingCallback: {
                    requestedMinutes: number
                    firesAt: number
                    scheduledByRunId: string
                } | null = null

                if (latestRun?.callbackFiresAt && latestRun.callbackFiresAt > Date.now()) {
                    pendingCallback = {
                        requestedMinutes: latestRun.callbackRequestedMinutes!,
                        firesAt: latestRun.callbackFiresAt,
                        scheduledByRunId: latestRun._id,
                    }
                }

                return {
                    _id: strategy._id,
                    name: strategy.name,
                    app: strategy.app,
                    enabled: strategy.enabled,
                    schedule: strategy.schedule,
                    latestRun: latestRun
                        ? {
                            _id: latestRun._id,
                            status: latestRun.status,
                            trigger: latestRun.trigger ?? "cron",
                            startedAt: latestRun.startedAt,
                            endedAt: latestRun.endedAt,
                            error: latestRun.error,
                        }
                        : null,
                    isRunning: activeRun !== null,
                    pendingCallback,
                }
            })
        )

        return results
    },
})

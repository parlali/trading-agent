import { query } from "../../_generated/server"
import { v } from "convex/values"
import { requireUser, requireServiceToken } from "../authGuards"

export const getRunHistory = query({
    args: {
        strategyId: v.id("strategies"),
        limit: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
        await requireUser(ctx)
        const limit = args.limit ?? 20
        return await ctx.db
            .query("strategy_runs")
            .withIndex("by_strategy", (q) => q.eq("strategyId", args.strategyId))
            .order("desc")
            .take(limit)
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
            endedAt: run.endedAt,
        }
    },
})

export const getActiveRun = query({
    args: { strategyId: v.id("strategies") },
    handler: async (ctx, args) => {
        await requireUser(ctx)
        return await ctx.db
            .query("strategy_runs")
            .withIndex("by_strategy_status", (q) =>
                q.eq("strategyId", args.strategyId).eq("status", "running")
            )
            .first()
    },
})

export const getAgentLogs = query({
    args: { runId: v.id("strategy_runs") },
    handler: async (ctx, args) => {
        await requireUser(ctx)
        return await ctx.db
            .query("agent_logs")
            .withIndex("by_run_sequence", (q) => q.eq("runId", args.runId))
            .collect()
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

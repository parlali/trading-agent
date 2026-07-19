import { query } from "../../_generated/server"
import type { Doc } from "../../_generated/dataModel"
import type { QueryCtx } from "../../_generated/server"
import { v } from "convex/values"
import { resolveRiskWindowStarts } from "@valiq-trading/core"
import { requireUserOrServiceToken } from "../authGuards"
import { collectBlockedExecutionSafetyFaultsForStrategy } from "../executionSafetyFaultReads"

const STRATEGY_EXECUTION_SAFETY_FAULT_LIMIT = 200

export const SUITE_REAL_APPS = ["okx-swap", "mt5", "alpaca-options"] as const
export const SUITE_DAY_STOP_PERCENT = 3
export const SUITE_WEEK_STOP_PERCENT = 6

export interface SuiteLossSnapshotValue {
    balance: number
    equity?: number
}

export interface SuiteLossComputationRow {
    app: typeof SUITE_REAL_APPS[number]
    latest: SuiteLossSnapshotValue
    dayBaseline?: SuiteLossSnapshotValue
    weekBaseline?: SuiteLossSnapshotValue
}

type SuiteLossAccountBucket = {
    app: typeof SUITE_REAL_APPS[number]
    accountId: string
}

export interface SuiteLossState {
    blocked: boolean
    reason?: string
    dayChangePercent: number
    weekChangePercent: number
    evaluatedAt: number
}

export const getStrategyRiskState = query({
    args: {
        serviceToken: v.optional(v.string()),
        strategyId: v.id("strategies"),
    },
    handler: async (ctx, args) => {
        await requireUserOrServiceToken(ctx, args.serviceToken)

        const row = await ctx.db
            .query("strategy_risk_states")
            .withIndex("by_strategy", (q) => q.eq("strategyId", args.strategyId))
            .first()

        if (!row) {
            return null
        }

        return {
            strategyId: String(row.strategyId),
            app: row.app,
            safetyState: row.safetyState,
            day: {
                realizedPnl: row.dayRealizedPnl,
                limit: row.dayDrawdownLimit,
                progress: row.dayDrawdownProgress,
            },
            week: {
                realizedPnl: row.weekRealizedPnl,
                limit: row.weekDrawdownLimit,
                progress: row.weekDrawdownProgress,
            },
            cooldown: {
                active: row.cooldownActive,
                reason: row.cooldownReason,
                startedAt: row.cooldownStartedAt,
                expiresAt: row.cooldownExpiresAt,
            },
            blockedInstruments: row.blockedInstruments,
            forcedExitClusterInstruments: row.forcedExitClusterInstruments ?? [],
            unresolvedExecutionFaultCount: row.unresolvedExecutionFaultCount,
            lastUpdatedAt: row.updatedAt,
        }
    },
})

export const getSuiteLossState = query({
    args: {
        serviceToken: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        await requireUserOrServiceToken(ctx, args.serviceToken)

        const evaluatedAt = Date.now()
        const { dayStartAt, weekStartAt } = resolveRiskWindowStarts(evaluatedAt, "UTC")
        const accountBuckets = await getSuiteLossAccountBuckets(ctx)
        const rows = (
            await Promise.all(
                accountBuckets.map((bucket) =>
                    getSuiteLossComputationRow(ctx, bucket, dayStartAt, weekStartAt)
                )
            )
        ).filter((row): row is SuiteLossComputationRow => row !== null)

        return computeSuiteLossState(rows, evaluatedAt)
    },
})

async function getSuiteLossAccountBuckets(ctx: QueryCtx): Promise<SuiteLossAccountBucket[]> {
    const accountRowsByApp = await Promise.all(
        SUITE_REAL_APPS.map((app) =>
            ctx.db
                .query("accounts")
                .withIndex("by_app", (q) => q.eq("app", app))
                .collect()
        )
    )

    return accountRowsByApp.flatMap((accounts, index) => {
        const app = SUITE_REAL_APPS[index]
        if (!app) {
            return []
        }

        return accounts.map((account) => ({
            app,
            accountId: account.accountId,
        }))
    })
}

async function getSuiteLossComputationRow(
    ctx: QueryCtx,
    bucket: SuiteLossAccountBucket,
    dayStartAt: number,
    weekStartAt: number
): Promise<SuiteLossComputationRow | null> {
    const [latest, dayBaseline, weekBaseline] = await Promise.all([
        getAccountSnapshotAtOrBefore(ctx, bucket),
        getAccountSnapshotAtOrBefore(ctx, bucket, dayStartAt),
        getAccountSnapshotAtOrBefore(ctx, bucket, weekStartAt),
    ])

    if (!latest) {
        return null
    }

    return {
        app: bucket.app,
        latest,
        dayBaseline: dayBaseline ?? undefined,
        weekBaseline: weekBaseline ?? undefined,
    }
}

async function getAccountSnapshotAtOrBefore(
    ctx: QueryCtx,
    bucket: SuiteLossAccountBucket,
    atOrBefore?: number
): Promise<Doc<"account_snapshots"> | null> {
    return await ctx.db
        .query("account_snapshots")
        .withIndex("by_app_account_timestamp", (q) => {
            const scoped = q.eq("app", bucket.app).eq("accountId", bucket.accountId)
            return atOrBefore === undefined
                ? scoped
                : scoped.lte("timestamp", atOrBefore)
        })
        .order("desc")
        .first()
}

export const getStrategyExecutionSafetyFaults = query({
    args: {
        serviceToken: v.optional(v.string()),
        strategyId: v.id("strategies"),
        unresolvedOnly: v.optional(v.boolean()),
    },
    handler: async (ctx, args) => {
        await requireUserOrServiceToken(ctx, args.serviceToken)

        const strategy = await ctx.db.get(args.strategyId)
        const [recentFaults, blockingFaults] = await Promise.all([
            ctx.db
                .query("execution_safety_faults")
                .withIndex("by_strategy", (q) => q.eq("strategyId", args.strategyId))
                .order("desc")
                .take(STRATEGY_EXECUTION_SAFETY_FAULT_LIMIT),
            args.unresolvedOnly && strategy
                ? collectBlockedExecutionSafetyFaultsForStrategy(ctx, {
                    strategyId: args.strategyId,
                    app: strategy.app,
                    accountId: strategy.accountId,
                })
                : [],
        ])
        const faultsById = new Map<string, Doc<"execution_safety_faults">>()
        for (const fault of [...recentFaults, ...blockingFaults]) {
            faultsById.set(String(fault._id), fault)
        }
        const faults = Array.from(faultsById.values())

        return faults
            .filter((fault) => args.unresolvedOnly ? fault.resolvedAt === undefined : true)
            .sort((left, right) => right.occurredAt - left.occurredAt)
    },
})

export function computeSuiteLossState(
    rows: SuiteLossComputationRow[],
    evaluatedAt = Date.now()
): SuiteLossState {
    let latestEquity = 0
    let dayBaselineEquity = 0
    let weekBaselineEquity = 0

    for (const row of rows) {
        const latest = resolveSuiteSnapshotEquity(row.latest)
        latestEquity += latest
        dayBaselineEquity += resolveSuiteSnapshotEquity(row.dayBaseline ?? row.latest)
        weekBaselineEquity += resolveSuiteSnapshotEquity(row.weekBaseline ?? row.latest)
    }

    const dayChangePercent = computeSuiteChangePercent(latestEquity, dayBaselineEquity)
    const weekChangePercent = computeSuiteChangePercent(latestEquity, weekBaselineEquity)
    const blocked = dayChangePercent <= -SUITE_DAY_STOP_PERCENT ||
        weekChangePercent <= -SUITE_WEEK_STOP_PERCENT

    return {
        blocked,
        reason: blocked ? formatSuiteLossStopReason(dayChangePercent, weekChangePercent) : undefined,
        dayChangePercent,
        weekChangePercent,
        evaluatedAt,
    }
}

function resolveSuiteSnapshotEquity(snapshot: SuiteLossSnapshotValue | Doc<"account_snapshots">): number {
    return snapshot.equity ?? snapshot.balance
}

function computeSuiteChangePercent(latestEquity: number, baselineEquity: number): number {
    if (baselineEquity === 0) {
        return 0
    }

    return 100 * (latestEquity - baselineEquity) / baselineEquity
}

function formatSuiteLossStopReason(dayChangePercent: number, weekChangePercent: number): string {
    return `Suite loss stop active: combined real-account equity ${dayChangePercent.toFixed(2)}% today (stop -${SUITE_DAY_STOP_PERCENT}%) / ${weekChangePercent.toFixed(2)}% this week (stop -${SUITE_WEEK_STOP_PERCENT}%). New entries are blocked suite-wide until the window resets.`
}

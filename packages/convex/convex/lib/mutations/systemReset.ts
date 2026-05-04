import { mutation } from "../../_generated/server"
import type { MutationCtx } from "../../_generated/server"
import type { Doc, TableNames } from "../../_generated/dataModel"
import { v } from "convex/values"
import type { App } from "@valiq-trading/core"
import { requireServiceToken } from "../authGuards"
import { createEmptyCascadeDeleteCounts, type CascadeDeleteCounts } from "../cascadeDelete"
import { appV } from "../validators"

type ResetBatchResult = CascadeDeleteCounts & { hasMore: boolean }

const RESET_VENUE_APPS = [
    "alpaca-options",
    "polymarket",
    "mt5",
    "okx-swap",
] as const

const RESET_APPS = [
    ...RESET_VENUE_APPS,
    "backend",
] as const

function resetBatchResult(
    deleted: CascadeDeleteCounts,
    hasMore: boolean
): ResetBatchResult {
    return {
        ...deleted,
        hasMore,
    }
}

async function deleteResetDoc<Table extends TableNames>(
    ctx: MutationCtx,
    doc: Pick<Doc<Table>, "_id">,
    deleted: CascadeDeleteCounts,
    countKey: keyof CascadeDeleteCounts
): Promise<ResetBatchResult> {
    await ctx.db.delete(doc._id)
    deleted[countKey]++
    return resetBatchResult(deleted, true)
}

async function deleteResetDocs<Table extends TableNames>(
    ctx: MutationCtx,
    docs: Array<Pick<Doc<Table>, "_id">>,
    deleted: CascadeDeleteCounts,
    countKey?: keyof CascadeDeleteCounts
): Promise<void> {
    for (const doc of docs) {
        await ctx.db.delete(doc._id)
        if (countKey) {
            deleted[countKey]++
        }
    }
}

async function deleteAllFromTable<Table extends TableNames>(
    ctx: MutationCtx,
    table: Table,
    deleted: CascadeDeleteCounts,
    countKey?: keyof CascadeDeleteCounts
): Promise<void> {
    const docs = await ctx.db.query(table).collect()
    for (const doc of docs) {
        await ctx.db.delete(doc._id)
        if (countKey) {
            deleted[countKey]++
        }
    }
}

export const clearFullResetState = mutation({
    args: {
        serviceToken: v.string(),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)

        const deleted = createEmptyCascadeDeleteCounts()

        await deleteAllFromTable(ctx, "strategy_risk_states", deleted, "strategyRiskStates")
        await deleteAllFromTable(ctx, "execution_safety_faults", deleted, "executionSafetyFaults")
        await deleteAllFromTable(ctx, "provider_sync_state", deleted, "providerSyncStates")
        await deleteAllFromTable(ctx, "account_snapshots", deleted, "accountSnapshots")
        await deleteAllFromTable(ctx, "app_heartbeats", deleted, "appHeartbeats")
        await deleteAllFromTable(ctx, "app_heartbeat_liveness", deleted, "appHeartbeats")
        await deleteAllFromTable(ctx, "app_heartbeat_snapshots", deleted, "appHeartbeats")
        await deleteAllFromTable(ctx, "control_plane_metrics", deleted)
        await deleteAllFromTable(ctx, "alerts", deleted, "alerts")

        return deleted
    },
})

export const clearFullResetStateBatch = mutation({
    args: {
        serviceToken: v.string(),
        batchSize: v.optional(v.number()),
        preserveApps: v.optional(v.array(appV)),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)

        const batchSize = Math.max(1, Math.min(args.batchSize ?? 20, 50))
        const preserveApps = new Set<App>(args.preserveApps ?? [])
        const deleted = createEmptyCascadeDeleteCounts()

        for (const app of RESET_VENUE_APPS) {
            if (preserveApps.has(app)) {
                continue
            }

            const riskState = await ctx.db
                .query("strategy_risk_states")
                .withIndex("by_app", (q) => q.eq("app", app))
                .first()

            if (riskState) {
                return await deleteResetDoc(ctx, riskState, deleted, "strategyRiskStates")
            }
        }

        for (const app of RESET_VENUE_APPS) {
            if (preserveApps.has(app)) {
                continue
            }

            const blockedFault = await ctx.db
                .query("execution_safety_faults")
                .withIndex("by_app_blocked", (q) => q.eq("app", app).eq("blocked", true))
                .first()

            if (blockedFault) {
                return await deleteResetDoc(ctx, blockedFault, deleted, "executionSafetyFaults")
            }

            const resolvedFault = await ctx.db
                .query("execution_safety_faults")
                .withIndex("by_app_blocked", (q) => q.eq("app", app).eq("blocked", false))
                .first()

            if (resolvedFault) {
                return await deleteResetDoc(ctx, resolvedFault, deleted, "executionSafetyFaults")
            }
        }

        for (const app of RESET_VENUE_APPS) {
            if (preserveApps.has(app)) {
                continue
            }

            const providerSyncState = await ctx.db
                .query("provider_sync_state")
                .withIndex("by_app", (q) => q.eq("app", app))
                .first()

            if (providerSyncState) {
                return await deleteResetDoc(ctx, providerSyncState, deleted, "providerSyncStates")
            }
        }

        for (const app of RESET_APPS) {
            if (preserveApps.has(app)) {
                continue
            }

            const liveness = await ctx.db
                .query("app_heartbeat_liveness")
                .withIndex("by_app", (q) => q.eq("app", app))
                .first()

            if (liveness) {
                return await deleteResetDoc(ctx, liveness, deleted, "appHeartbeats")
            }
        }

        for (const app of RESET_APPS) {
            if (preserveApps.has(app)) {
                continue
            }

            const snapshot = await ctx.db
                .query("app_heartbeat_snapshots")
                .withIndex("by_app", (q) => q.eq("app", app))
                .first()

            if (snapshot) {
                return await deleteResetDoc(ctx, snapshot, deleted, "appHeartbeats")
            }
        }

        for (const app of RESET_APPS) {
            if (preserveApps.has(app)) {
                continue
            }

            const snapshots = await ctx.db
                .query("account_snapshots")
                .withIndex("by_app", (q) => q.eq("app", app))
                .take(batchSize)

            if (snapshots.length > 0) {
                await deleteResetDocs(ctx, snapshots, deleted, "accountSnapshots")
                return resetBatchResult(deleted, true)
            }
        }

        for (const app of RESET_APPS) {
            if (preserveApps.has(app)) {
                continue
            }

            const heartbeat = await ctx.db
                .query("app_heartbeats")
                .withIndex("by_app", (q) => q.eq("app", app))
                .first()

            if (heartbeat) {
                return await deleteResetDoc(ctx, heartbeat, deleted, "appHeartbeats")
            }
        }

        if (preserveApps.size === 0) {
            const alerts = await ctx.db.query("alerts").order("asc").take(batchSize)

            if (alerts.length > 0) {
                await deleteResetDocs(ctx, alerts, deleted, "alerts")
                return resetBatchResult(deleted, true)
            }
        }

        return resetBatchResult(deleted, false)
    },
})

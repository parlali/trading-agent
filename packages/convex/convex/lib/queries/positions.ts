import { query } from "../../_generated/server"
import { v } from "convex/values"
import { requireUser, requireServiceTokenForQueryContext } from "../authGuards"
import { getLatestPositionsForStrategy } from "../instrumentClaims"
import { isDryRunLedgerMetadata } from "../dryRunLedger"

const DEFAULT_POSITION_SYNC_SCAN_LIMIT = 200
const MAX_POSITION_SYNC_SCAN_LIMIT = 1000

export const getOpenPositions = query({
    args: { strategyId: v.id("strategies") },
    handler: async (ctx, args) => {
        await requireUser(ctx)
        const positions = await getLatestPositionsForStrategy(ctx, args.strategyId)
        return positions.filter((position) => !isDryRunLedgerMetadata(position.metadata))
    },
})

export const getStrategyPositions = query({
    args: { serviceToken: v.string(), strategyId: v.id("strategies") },
    handler: async (ctx, args) => {
        requireServiceTokenForQueryContext(args.serviceToken, ctx)
        return await getLatestPositionsForStrategy(ctx, args.strategyId)
    },
})

export const getStrategyPositionsForRun = query({
    args: {
        serviceToken: v.string(),
        strategyId: v.id("strategies"),
        runId: v.id("strategy_runs"),
        maxSyncs: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
        requireServiceTokenForQueryContext(args.serviceToken, ctx)
        const maxSyncs = resolvePositionSyncScanLimit(args.maxSyncs)
        const syncs = await ctx.db
            .query("position_syncs")
            .withIndex("by_strategy_synced_at", (q) => q.eq("strategyId", args.strategyId))
            .order("desc")
            .take(maxSyncs)

        for (const sync of syncs) {
            if (sync.positionCount === 0) {
                continue
            }

            const positions = await ctx.db
                .query("positions")
                .withIndex("by_strategy_synced_at", (q) =>
                    q.eq("strategyId", args.strategyId).eq("syncedAt", sync.syncedAt)
                )
                .collect()
            const ledger = positions.find((position) => isDryRunLedgerMetadata(position.metadata))
            if (readSourceRunId(ledger?.metadata) === String(args.runId)) {
                return positions
            }
        }

        return []
    },
})

function resolvePositionSyncScanLimit(value: number | undefined): number {
    if (value === undefined) {
        return DEFAULT_POSITION_SYNC_SCAN_LIMIT
    }
    if (!Number.isInteger(value) || value < 1 || value > MAX_POSITION_SYNC_SCAN_LIMIT) {
        throw new Error(`getStrategyPositionsForRun maxSyncs must be a positive integer between 1 and ${MAX_POSITION_SYNC_SCAN_LIMIT}`)
    }

    return value
}

function readSourceRunId(metadata: string | undefined): string | undefined {
    if (!metadata) {
        return undefined
    }

    try {
        const parsed = JSON.parse(metadata)
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.sourceRunId === "string"
            ? parsed.sourceRunId
            : undefined
    } catch {
        return undefined
    }
}

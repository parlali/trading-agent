import { query } from "../../_generated/server"
import type { Doc } from "../../_generated/dataModel"
import { v } from "convex/values"
import type { StrategyOperationalMemory } from "@valiq-trading/core"
import { requireServiceToken } from "../authGuards"
import { venueAppV } from "../validators"
import {
    isStrategyOperationalMemoryApplicable,
    rankStrategyOperationalMemories,
    type OperationalMemoryToolManifestEntry,
} from "../operationalMemory"

const DEFAULT_MEMORY_LIMIT = 12
const MAX_MEMORY_LIMIT = 20

const toolManifestEntryV = v.object({
    name: v.string(),
    schemaHash: v.optional(v.string()),
    category: v.optional(v.string()),
    contractBoundary: v.optional(v.string()),
    contractOwner: v.optional(v.string()),
})

export const getApplicableStrategyOperationalMemory = query({
    args: {
        serviceToken: v.string(),
        strategyId: v.id("strategies"),
        app: venueAppV,
        accountId: v.string(),
        toolManifest: v.array(toolManifestEntryV),
        now: v.optional(v.number()),
        limit: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        const now = args.now ?? Date.now()
        const limit = resolveLimit(args.limit)
        const rows = await ctx.db
            .query("strategy_operational_memories")
            .withIndex("by_strategy_status", (q) =>
                q.eq("strategyId", args.strategyId).eq("status", "active")
            )
            .collect()
        const toolManifest: OperationalMemoryToolManifestEntry[] = args.toolManifest

        return rankStrategyOperationalMemories(
            rows
                .map(toStrategyOperationalMemory)
                .filter((memory) => isStrategyOperationalMemoryApplicable({
                    memory,
                    app: args.app,
                    accountId: args.accountId,
                    toolManifest,
                    now,
                }))
        ).slice(0, limit)
    },
})

function resolveLimit(value: number | undefined): number {
    if (value === undefined) {
        return DEFAULT_MEMORY_LIMIT
    }
    if (!Number.isInteger(value) || value < 1) {
        throw new Error("getApplicableStrategyOperationalMemory limit must be a positive integer")
    }

    return Math.min(value, MAX_MEMORY_LIMIT)
}

function toStrategyOperationalMemory(
    row: Doc<"strategy_operational_memories">
): StrategyOperationalMemory {
    return {
        schemaVersion: row.schemaVersion,
        memoryKey: row.memoryKey,
        strategyId: row.strategyId,
        app: row.app,
        accountId: row.accountId,
        type: row.type,
        status: row.status,
        severity: row.severity,
        confidence: row.confidence,
        scope: row.scope,
        sources: row.sources,
        evidence: row.evidence,
        lesson: row.lesson,
        ranking: row.ranking,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    }
}

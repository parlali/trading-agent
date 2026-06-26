import { query } from "../../_generated/server"
import type { Doc } from "../../_generated/dataModel"
import type { QueryCtx } from "../../_generated/server"
import { v } from "convex/values"
import type { StrategyOperationalMemory } from "@valiq-trading/core"
import { requireServiceToken } from "../authGuards"
import { venueAppV } from "../validators"
import {
    isStrategyOperationalMemoryApplicable,
    rankStrategyOperationalMemories,
    type OperationalMemoryToolManifestEntry,
} from "../operationalMemory"
import {
    STRATEGY_OPERATIONAL_MEMORY_PROJECTION_VERSION,
} from "../operationalMemoryProjection"

const DEFAULT_MEMORY_LIMIT = 12
const MAX_MEMORY_LIMIT = 20
const STALE_OPERATIONAL_MEMORY_PROJECTION_VERSIONS: Array<number | undefined> = [undefined, 1]

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
        const toolManifest: OperationalMemoryToolManifestEntry[] = args.toolManifest
        const rows = await collectStrategyOperationalMemoryRows(ctx, {
            strategyId: args.strategyId,
            app: args.app,
            accountId: args.accountId,
            toolManifest,
            limit,
        })

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

async function collectStrategyOperationalMemoryRows(
    ctx: Pick<QueryCtx, "db">,
    args: {
        strategyId: Doc<"strategy_operational_memories">["strategyId"]
        app: Doc<"strategy_operational_memories">["app"]
        accountId: string
        toolManifest: OperationalMemoryToolManifestEntry[]
        limit: number
    }
): Promise<Array<Doc<"strategy_operational_memories">>> {
    for (const projectionVersion of STALE_OPERATIONAL_MEMORY_PROJECTION_VERSIONS) {
        const staleProjection = await ctx.db
            .query("strategy_operational_memories")
            .withIndex("by_strategy_status_projection", (q) =>
                q
                    .eq("strategyId", args.strategyId)
                    .eq("status", "active")
                    .eq("projectionVersion", projectionVersion)
            )
            .first()

        if (staleProjection) {
            return await collectStrategyOperationalMemoryRowsByStatus(ctx, args.strategyId)
        }
    }

    const rowsById = new Map<string, Doc<"strategy_operational_memories">>()
    const addRows = (rows: Array<Doc<"strategy_operational_memories">>): void => {
        for (const row of rows) {
            rowsById.set(String(row._id), row)
        }
    }

    const toolScopeQueriesByKey = new Map<string, {
        scopeProviderId: string | undefined
        toolName: string
        schemaHash: string | undefined
    }>()
    for (const tool of args.toolManifest) {
        const providerId = readProviderId(tool)
        const providerIds = providerId ? [providerId, undefined] : [undefined]
        const schemaHashes = tool.schemaHash ? [tool.schemaHash, undefined] : [undefined]
        for (const scopeProviderId of providerIds) {
            for (const schemaHash of schemaHashes) {
                toolScopeQueriesByKey.set(
                    `${scopeProviderId ?? ""}\0${tool.name}\0${schemaHash ?? ""}`,
                    {
                        scopeProviderId,
                        toolName: tool.name,
                        schemaHash,
                    }
                )
            }
        }
    }

    for (const query of toolScopeQueriesByKey.values()) {
        addRows(await collectStrategyOperationalMemoryRowsByScope(ctx, {
            strategyId: args.strategyId,
            app: args.app,
            accountId: args.accountId,
            providerId: query.scopeProviderId,
            toolName: query.toolName,
            schemaHash: query.schemaHash,
            limit: args.limit,
        }))
    }

    addRows(await collectStrategyOperationalMemoryRowsByScope(ctx, {
        strategyId: args.strategyId,
        app: args.app,
        accountId: args.accountId,
        providerId: undefined,
        toolName: undefined,
        schemaHash: undefined,
        limit: args.limit,
    }))

    for (const providerId of collectProviderIds(args.toolManifest)) {
        addRows(await collectStrategyOperationalMemoryRowsByScope(ctx, {
            strategyId: args.strategyId,
            app: args.app,
            accountId: args.accountId,
            providerId,
            toolName: undefined,
            schemaHash: undefined,
            limit: args.limit,
        }))
    }

    return Array.from(rowsById.values())
}

async function collectStrategyOperationalMemoryRowsByScope(
    ctx: Pick<QueryCtx, "db">,
    args: {
        strategyId: Doc<"strategy_operational_memories">["strategyId"]
        app: Doc<"strategy_operational_memories">["app"]
        accountId: string
        providerId: string | undefined
        toolName: string | undefined
        schemaHash: string | undefined
        limit: number
    }
): Promise<Array<Doc<"strategy_operational_memories">>> {
    return await ctx.db
        .query("strategy_operational_memories")
        .withIndex("by_strategy_status_scope_provider_tool_schema_rank", (q) =>
            q
                .eq("strategyId", args.strategyId)
                .eq("status", "active")
                .eq("projectionVersion", STRATEGY_OPERATIONAL_MEMORY_PROJECTION_VERSION)
                .eq("scopeApp", args.app)
                .eq("scopeAccountId", args.accountId)
                .eq("scopeProviderId", args.providerId)
                .eq("scopeToolName", args.toolName)
                .eq("scopeSchemaHash", args.schemaHash)
        )
        .order("desc")
        .take(args.limit)
}

async function collectStrategyOperationalMemoryRowsByStatus(
    ctx: Pick<QueryCtx, "db">,
    strategyId: Doc<"strategy_operational_memories">["strategyId"]
): Promise<Array<Doc<"strategy_operational_memories">>> {
    return await ctx.db
        .query("strategy_operational_memories")
        .withIndex("by_strategy_status", (q) =>
            q.eq("strategyId", strategyId).eq("status", "active")
        )
        .collect()
}

function collectProviderIds(toolManifest: OperationalMemoryToolManifestEntry[]): string[] {
    const providerIds = new Set<string>()
    for (const tool of toolManifest) {
        const providerId = readProviderId(tool)
        if (providerId) {
            providerIds.add(providerId)
        }
    }

    return Array.from(providerIds)
}

function readProviderId(tool: OperationalMemoryToolManifestEntry): string | undefined {
    const owner = tool.contractOwner
    return owner?.startsWith("mcp:")
        ? owner.slice("mcp:".length)
        : undefined
}

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

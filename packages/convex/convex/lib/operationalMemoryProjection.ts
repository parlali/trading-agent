import type { Doc } from "../_generated/dataModel"

export const STRATEGY_OPERATIONAL_MEMORY_PROJECTION_VERSION = 2

export type StrategyOperationalMemoryProjection = {
    projectionVersion: number
    scopeApp: Doc<"strategy_operational_memories">["app"]
    scopeAccountId: string
    scopeProviderId?: string
    scopeToolName?: string
    scopeSchemaHash?: string
    rankSeverity: number
    rankScore: number
}

export function buildStrategyOperationalMemoryProjection(
    memory: Pick<Doc<"strategy_operational_memories">, "scope" | "ranking" | "severity">
): StrategyOperationalMemoryProjection {
    return {
        projectionVersion: STRATEGY_OPERATIONAL_MEMORY_PROJECTION_VERSION,
        scopeApp: memory.scope.app,
        scopeAccountId: memory.scope.accountId,
        scopeProviderId: memory.scope.providerId,
        scopeToolName: memory.scope.toolName,
        scopeSchemaHash: memory.scope.schemaHash,
        rankSeverity: rankSeverity(memory.severity),
        rankScore: memory.ranking.score,
    }
}

export function strategyOperationalMemoryProjectionChanged(
    row: Doc<"strategy_operational_memories">,
    projection: StrategyOperationalMemoryProjection
): boolean {
    return row.projectionVersion !== projection.projectionVersion ||
        row.scopeApp !== projection.scopeApp ||
        row.scopeAccountId !== projection.scopeAccountId ||
        row.scopeProviderId !== projection.scopeProviderId ||
        row.scopeToolName !== projection.scopeToolName ||
        row.scopeSchemaHash !== projection.scopeSchemaHash ||
        row.rankSeverity !== projection.rankSeverity ||
        row.rankScore !== projection.rankScore
}

function rankSeverity(severity: Doc<"strategy_operational_memories">["severity"]): number {
    if (severity === "critical") {
        return 4
    }
    if (severity === "high") {
        return 3
    }
    if (severity === "medium") {
        return 2
    }

    return 1
}

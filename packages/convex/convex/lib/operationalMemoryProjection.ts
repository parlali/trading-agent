import type { Doc } from "../_generated/dataModel"

export const STRATEGY_OPERATIONAL_MEMORY_PROJECTION_VERSION = 1

export type StrategyOperationalMemoryProjection = {
    projectionVersion: number
    scopeApp: Doc<"strategy_operational_memories">["app"]
    scopeAccountId: string
    scopeProviderId?: string
    scopeToolName?: string
    scopeSchemaHash?: string
}

export function buildStrategyOperationalMemoryProjection(
    memory: Pick<Doc<"strategy_operational_memories">, "scope" | "ranking">
): StrategyOperationalMemoryProjection {
    return {
        projectionVersion: STRATEGY_OPERATIONAL_MEMORY_PROJECTION_VERSION,
        scopeApp: memory.scope.app,
        scopeAccountId: memory.scope.accountId,
        scopeProviderId: memory.scope.providerId,
        scopeToolName: memory.scope.toolName,
        scopeSchemaHash: memory.scope.schemaHash,
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
        row.scopeSchemaHash !== projection.scopeSchemaHash
}

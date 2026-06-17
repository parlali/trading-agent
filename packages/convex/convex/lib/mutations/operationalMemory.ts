import { mutation, type DatabaseWriter } from "../../_generated/server"
import type { Doc, Id } from "../../_generated/dataModel"
import { v } from "convex/values"
import type { StrategyOperationalMemory, StrategyOperationalMemorySeverity } from "@valiq-trading/core"
import { requireServiceToken } from "../authGuards"
import { buildStrategyOperationalMemoryFromRun } from "../operationalMemory"

const MAX_MEMORY_SOURCES = 8

export const refreshStrategyOperationalMemoryFromRun = mutation({
    args: {
        serviceToken: v.string(),
        runId: v.id("strategy_runs"),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)

        const run = await ctx.db.get(args.runId)
        if (!run) {
            return {
                upserted: 0,
                skipped: "run_not_found",
            }
        }
        if (run.status !== "completed") {
            return {
                upserted: 0,
                skipped: `run_status_${run.status}`,
            }
        }

        const strategy = await ctx.db.get(run.strategyId)
        if (!strategy) {
            return {
                upserted: 0,
                skipped: "strategy_not_found",
            }
        }

        const agentLogs = await ctx.db
            .query("agent_logs")
            .withIndex("by_run_sequence", (q) => q.eq("runId", args.runId))
            .collect()
        const now = Date.now()
        const candidates = buildStrategyOperationalMemoryFromRun({
            run: {
                _id: run._id,
                strategyId: run.strategyId,
                app: run.app,
                accountId: run.accountId,
                status: run.status,
                startedAt: run.startedAt,
                endedAt: run.endedAt,
                summary: run.summary,
                systemContextDigest: run.systemContextDigest,
                mcpToolDiagnostics: run.mcpToolDiagnostics,
                toolManifest: run.toolManifest,
            },
            strategy: {
                _id: strategy._id,
                app: strategy.app,
                accountId: strategy.accountId,
            },
            agentLogs: agentLogs.map((log) => ({
                _id: log._id,
                runId: log.runId,
                strategyId: log.strategyId,
                sequence: log.sequence,
                role: log.role,
                content: log.content,
                toolName: log.toolName,
                toolInput: log.toolInput,
                toolOutput: log.toolOutput,
                timestamp: log.timestamp,
            })),
            now,
        })

        let upserted = 0
        for (const candidate of candidates) {
            await upsertMemory(ctx.db, candidate)
            upserted++
        }

        return { upserted }
    },
})

async function upsertMemory(
    db: DatabaseWriter,
    candidate: StrategyOperationalMemory
): Promise<void> {
    const existing = await db.query("strategy_operational_memories")
        .withIndex("by_memory_key", (q) => q.eq("memoryKey", candidate.memoryKey))
        .first()

    if (!existing) {
        await db.insert("strategy_operational_memories", toStoredMemory(candidate))
        return
    }

    const replace = candidate.type === "run_handoff_fact"
    await db.patch(existing._id, {
        status: "active",
        severity: higherSeverity(existing.severity, candidate.severity),
        confidence: Math.max(existing.confidence, candidate.confidence),
        scope: toStoredMemory(candidate).scope,
        sources: replace
            ? candidate.sources
            : mergeSources(existing.sources, candidate.sources),
        evidence: replace
            ? candidate.evidence
            : {
                attemptCount: existing.evidence.attemptCount + candidate.evidence.attemptCount,
                successCount: existing.evidence.successCount + candidate.evidence.successCount,
                failureCount: existing.evidence.failureCount + candidate.evidence.failureCount,
                lastErrorSignature: candidate.evidence.lastErrorSignature ?? existing.evidence.lastErrorSignature,
                sanitizedInputFingerprint: candidate.evidence.sanitizedInputFingerprint ?? existing.evidence.sanitizedInputFingerprint,
                sanitizedOutputDigest: candidate.evidence.sanitizedOutputDigest ?? existing.evidence.sanitizedOutputDigest,
            },
        lesson: candidate.lesson,
        ranking: {
            score: Math.max(existing.ranking.score, candidate.ranking.score),
            expiresAt: candidate.ranking.expiresAt,
            supersededBy: candidate.ranking.supersededBy,
        },
        updatedAt: candidate.updatedAt,
    })
}

function toStoredMemory(
    memory: StrategyOperationalMemory
): Omit<Doc<"strategy_operational_memories">, "_id" | "_creationTime"> {
    return {
        schemaVersion: 1,
        memoryKey: memory.memoryKey,
        strategyId: memory.strategyId as Id<"strategies">,
        app: memory.app,
        accountId: memory.accountId,
        type: memory.type,
        status: memory.status,
        severity: memory.severity,
        confidence: memory.confidence,
        scope: memory.scope,
        sources: memory.sources,
        evidence: memory.evidence,
        lesson: memory.lesson,
        ranking: memory.ranking,
        createdAt: memory.createdAt,
        updatedAt: memory.updatedAt,
    }
}

function mergeSources(
    existing: StrategyOperationalMemory["sources"],
    next: StrategyOperationalMemory["sources"]
): StrategyOperationalMemory["sources"] {
    const byKey = new Map<string, StrategyOperationalMemory["sources"][number]>()
    for (const source of [...existing, ...next]) {
        byKey.set(sourceKey(source), source)
    }

    return Array.from(byKey.values())
        .sort((left, right) => right.timestamp - left.timestamp)
        .slice(0, MAX_MEMORY_SOURCES)
}

function sourceKey(source: StrategyOperationalMemory["sources"][number]): string {
    return [
        source.runId,
        source.agentLogId,
        source.chatSessionId,
        source.chatMessageId,
        source.toolCallId,
        source.timestamp,
    ].join("|")
}

function higherSeverity(
    left: StrategyOperationalMemorySeverity,
    right: StrategyOperationalMemorySeverity
): StrategyOperationalMemorySeverity {
    return severityRank(right) > severityRank(left) ? right : left
}

function severityRank(severity: StrategyOperationalMemorySeverity): number {
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

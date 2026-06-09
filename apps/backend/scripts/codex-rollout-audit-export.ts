import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { resolveStrategyLlmConfig } from "@valiq-trading/core"
import type { StoredRun, StoredStrategy } from "@valiq-trading/convex"
import {
    collectCodexRunAuditArtifact,
    findStrategyRunHistoryMatches,
    refreshProviderSyncForAudit,
    resolveAuditOutputPath,
    resolveStrategySelection,
} from "./lib/codex-audit-cli"
import { buildCodexRolloutAuditArtifact } from "./lib/codex-rollout-audit"
import {
    createClient,
    resolveArg,
    resolveFlag,
    resolvePositiveIntegerArg,
    runScript,
} from "./lib/strategy-cli"

runScript(exportCodexRolloutAudit)

async function exportCodexRolloutAudit(): Promise<void> {
    const client = createClient()
    const strategyId = resolveArg("strategy")
    const strategyName = resolveArg("strategy-name")
    const minScheduledRuns = resolveMinScheduledRuns()
    assertProviderSyncRefreshArgs()

    if (!strategyId && !strategyName) {
        throw new Error("--strategy or --strategy-name is required")
    }

    const strategy = await resolveStrategySelection(client, {
        strategyId,
        strategyName,
    })
    if (resolveFlag("refresh-provider-sync")) {
        const refreshStrategy = await refreshProviderSyncForAudit({
            client,
            targetStrategy: strategy,
            providerSyncStrategyId: resolveArg("provider-sync-strategy"),
        })
        console.log(`Provider-sync refreshed with ${refreshStrategy.name} (${refreshStrategy._id}) before Codex rollout audit export`)
    }
    const allStrategies = await client.getAllStrategies()
    const scheduledRuns = await resolveScheduledCodexRuns({
        client,
        strategy,
        minScheduledRuns,
    })
    const exportedAt = new Date().toISOString()
    const runAudits = await Promise.all(scheduledRuns.map((run) =>
        collectCodexRunAuditArtifact({
            client,
            strategy,
            run,
            exportedAt,
        })
    ))
    const openRouterStrategies = allStrategies.filter((candidate) =>
        resolveStrategyLlmConfig(candidate.policy).provider === "openrouter"
    )
    const rolloutStartedAt = scheduledRuns.length > 0
        ? Math.min(...scheduledRuns.map((run) => run.startedAt))
        : undefined
    const openRouterSamples = await Promise.all(openRouterStrategies.map(async (candidate) => ({
        strategy: candidate,
        runs: rolloutStartedAt === undefined
            ? await client.getRunHistory(candidate._id, 500)
            : await resolveOpenRouterRunsSince({
                client,
                strategy: candidate,
                rolloutStartedAt,
            }),
    })))
    const artifact = buildCodexRolloutAuditArtifact({
        exportedAt,
        targetStrategy: strategy,
        allStrategies,
        runAudits,
        openRouterSamples,
        minScheduledRuns,
    })
    const outputPath = resolveAuditOutputPath({
        outputArg: resolveArg("out"),
        defaultFileName: `codex-rollout-audit-${strategy._id}.json`,
    })

    await mkdir(dirname(outputPath), {
        recursive: true,
    })
    await writeFile(outputPath, `${JSON.stringify(artifact, null, 4)}\n`, "utf8")

    console.log(`Codex rollout audit artifact: ${outputPath}`)
    console.log(JSON.stringify({
        targetStrategy: artifact.targetStrategy,
        gates: artifact.gates,
        scheduledCodexRunIds: artifact.evidence.scheduledCodexRunIds,
        openRouterIsolation: artifact.evidence.openRouterIsolation,
        failures: artifact.failures,
    }, null, 4))

    if (artifact.failures.length > 0) {
        throw new Error(`Codex rollout audit failed ${artifact.failures.length} gate(s)`)
    }
}

async function resolveOpenRouterRunsSince(args: {
    client: ReturnType<typeof createClient>
    strategy: StoredStrategy
    rolloutStartedAt: number
}): Promise<StoredRun[]> {
    return await findStrategyRunHistoryMatches({
        client: args.client,
        strategyId: args.strategy._id,
        minMatches: Number.POSITIVE_INFINITY,
        initialLimit: 500,
        matches: (run) => run.startedAt >= args.rolloutStartedAt,
        stopAfterPage: (runs) =>
            runs.some((run) => run.startedAt < args.rolloutStartedAt),
        pageLimitError: `OpenRouter rollout sample for ${args.strategy.name} (${args.strategy._id}) exceeded bounded history scan before reaching rollout start ${args.rolloutStartedAt}`,
    })
}

async function resolveScheduledCodexRuns(args: {
    client: ReturnType<typeof createClient>
    strategy: Awaited<ReturnType<typeof resolveStrategySelection>>
    minScheduledRuns: number
}): Promise<StoredRun[]> {
    return await findStrategyRunHistoryMatches({
        client: args.client,
        strategyId: args.strategy._id,
        minMatches: args.minScheduledRuns,
        initialLimit: Math.max(100, args.minScheduledRuns * 10),
        matches: (run) =>
            run.status === "completed" &&
            run.trigger === "cron" &&
            run.llmProvider === "codex",
    })
}

function resolveMinScheduledRuns(): number {
    return resolvePositiveIntegerArg("min-runs", 3, {
        min: 1,
        max: 50,
    })
}

function assertProviderSyncRefreshArgs(): void {
    if (resolveArg("provider-sync-strategy") && !resolveFlag("refresh-provider-sync")) {
        throw new Error("--provider-sync-strategy requires --refresh-provider-sync")
    }
}

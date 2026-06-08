import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { resolveStrategyLlmConfig } from "@valiq-trading/core"
import type { StoredRun } from "@valiq-trading/convex"
import {
    collectCodexRunAuditArtifact,
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
    const openRouterSamples = await Promise.all(openRouterStrategies.map(async (candidate) => ({
        strategy: candidate,
        runs: await client.getRunHistory(candidate._id, 50),
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

async function resolveScheduledCodexRuns(args: {
    client: ReturnType<typeof createClient>
    strategy: Awaited<ReturnType<typeof resolveStrategySelection>>
    minScheduledRuns: number
}): Promise<StoredRun[]> {
    const runs = await args.client.getRunHistory(args.strategy._id, Math.max(100, args.minScheduledRuns * 10))

    return runs
        .filter((run) =>
            run.status === "completed" &&
            run.trigger === "cron" &&
            run.llmProvider === "codex"
        )
        .slice(0, args.minScheduledRuns)
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

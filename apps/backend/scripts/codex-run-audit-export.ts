import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import {
    collectCodexRunAuditArtifact,
    refreshProviderSyncForAudit,
    resolveAuditOutputPath,
    resolveCodexStrategyAndRun,
} from "./lib/codex-audit-cli"
import {
    createClient,
    resolveArg,
    resolveFlag,
    runScript,
} from "./lib/strategy-cli"

runScript(exportCodexRunAudit)

async function exportCodexRunAudit(): Promise<void> {
    const client = createClient()
    assertProviderSyncRefreshArgs()
    const { strategy, run } = await resolveCodexStrategyAndRun(client)
    if (resolveFlag("refresh-provider-sync")) {
        const refreshStrategy = await refreshProviderSyncForAudit({
            client,
            targetStrategy: strategy,
            providerSyncStrategyId: resolveArg("provider-sync-strategy"),
        })
        console.log(`Provider-sync refreshed with ${refreshStrategy.name} (${refreshStrategy._id}) before Codex run audit export`)
    }
    const artifact = await collectCodexRunAuditArtifact({
        client,
        exportedAt: new Date().toISOString(),
        strategy,
        run,
    })
    const outputPath = resolveOutputPath(run)

    await mkdir(dirname(outputPath), {
        recursive: true,
    })
    await writeFile(outputPath, `${JSON.stringify(artifact, null, 4)}\n`, "utf8")

    console.log(`Codex run audit artifact: ${outputPath}`)
    console.log(JSON.stringify({
        strategy: artifact.strategy,
        run: artifact.run,
        gates: artifact.gates,
        failures: artifact.failures,
    }, null, 4))

    if (artifact.failures.length > 0) {
        throw new Error(`Codex run audit failed ${artifact.failures.length} gate(s)`)
    }
}

function resolveOutputPath(run: { _id: string }): string {
    return resolveAuditOutputPath({
        outputArg: resolveArg("out"),
        defaultFileName: `codex-run-audit-${run._id}.json`,
    })
}

function assertProviderSyncRefreshArgs(): void {
    if (resolveArg("provider-sync-strategy") && !resolveFlag("refresh-provider-sync")) {
        throw new Error("--provider-sync-strategy requires --refresh-provider-sync")
    }
}

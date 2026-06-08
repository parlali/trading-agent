import {
    resolveStrategyLlmConfig,
    type App,
} from "@valiq-trading/core"
import type {
    StoredRun,
    StoredStrategy,
} from "@valiq-trading/convex"
import type { CodexRunAuditArtifact } from "./codex-run-audit"

export interface CodexRolloutOpenRouterSample {
    strategy: StoredStrategy
    runs: StoredRun[]
}

export interface CodexRolloutAuditInput {
    exportedAt: string
    targetStrategy: StoredStrategy
    allStrategies: StoredStrategy[]
    runAudits: CodexRunAuditArtifact[]
    openRouterSamples: CodexRolloutOpenRouterSample[]
    minScheduledRuns?: number
}

export interface CodexRolloutAuditArtifact {
    exportedAt: string
    targetStrategy: {
        id: string
        name: string
        app: App
        enabled: boolean
        dryRun: boolean
        llmProvider: string
        llmModel: string
        llmAuthMode?: string
    }
    evidence: {
        minScheduledRuns: number
        scheduledCodexRunIds: string[]
        auditedRunIds: string[]
        enabledCodexStrategies: Array<{
            id: string
            name: string
            app: App
            dryRun: boolean
        }>
        codexLiveStrategies: Array<{
            id: string
            name: string
            app: App
            enabled: boolean
        }>
        runComparison: {
            models: string[]
            authModes: string[]
            billingModes: string[]
            toolNameSets: Array<{
                runId: string
                toolNames: string[]
            }>
            dryRunPositionCounts: Array<{
                runId: string
                count: number
            }>
            summariesPresent: Array<{
                runId: string
                present: boolean
            }>
            mismatches: string[]
        }
        openRouterIsolation: {
            strategyCount: number
            enabledStrategyCount: number
            sampledRunCount: number
            rolloutStartedAt?: number
            mismatches: string[]
        }
    }
    gates: {
        targetStrategyIsCodexDryRun: boolean
        singleEnabledCodexDryRunStrategy: boolean
        liveCodexExecutionBlocked: boolean
        scheduledCodexRunCount: boolean
        codexRunAuditsPass: boolean
        codexRunsComparable: boolean
        openRouterProviderIsolation: boolean
    }
    failures: string[]
}

export function buildCodexRolloutAuditArtifact(input: CodexRolloutAuditInput): CodexRolloutAuditArtifact {
    const minScheduledRuns = input.minScheduledRuns ?? 3
    const targetLlm = resolveStrategyLlmConfig(input.targetStrategy.policy)
    const strategySummaries = input.allStrategies.map((strategy) => {
        const llm = resolveStrategyLlmConfig(strategy.policy)

        return {
            id: String(strategy._id),
            name: strategy.name,
            app: strategy.app,
            enabled: strategy.enabled,
            dryRun: strategy.policy.dryRun === true,
            llmProvider: llm.provider,
            llmModel: llm.model,
            llmAuthMode: llm.provider === "codex" ? llm.authMode : undefined,
        }
    })
    const enabledCodexStrategies = strategySummaries.filter((strategy) =>
        strategy.enabled &&
        strategy.llmProvider === "codex"
    )
    const enabledCodexDryRunStrategies = enabledCodexStrategies.filter((strategy) => strategy.dryRun)
    const codexLiveStrategies = strategySummaries.filter((strategy) =>
        strategy.llmProvider === "codex" &&
        !strategy.dryRun
    )
    const scheduledRunAudits = input.runAudits.filter((audit) => audit.run.trigger === "cron")
    const rolloutStartedAt = scheduledRunAudits.length > 0
        ? Math.min(...scheduledRunAudits.map((audit) => audit.run.startedAt))
        : undefined
    const runComparison = buildRunComparison({
        targetStrategy: input.targetStrategy,
        runAudits: scheduledRunAudits,
    })
    const openRouterIsolation = buildOpenRouterIsolation({
        samples: input.openRouterSamples,
        rolloutStartedAt,
        enabledOpenRouterStrategies: strategySummaries.filter((strategy) =>
            strategy.enabled &&
            strategy.llmProvider === "openrouter"
        ),
    })
    const gates = {
        targetStrategyIsCodexDryRun: targetLlm.provider === "codex" && input.targetStrategy.policy.dryRun === true,
        singleEnabledCodexDryRunStrategy: enabledCodexDryRunStrategies.length === 1 &&
            enabledCodexDryRunStrategies[0]?.id === String(input.targetStrategy._id),
        liveCodexExecutionBlocked: codexLiveStrategies.length === 0 &&
            input.runAudits.every((audit) => audit.strategy.dryRun === true),
        scheduledCodexRunCount: scheduledRunAudits.length >= minScheduledRuns,
        codexRunAuditsPass: input.runAudits.length > 0 &&
            scheduledRunAudits.every((audit) => audit.failures.length === 0),
        codexRunsComparable: runComparison.mismatches.length === 0,
        openRouterProviderIsolation: openRouterIsolation.mismatches.length === 0,
    }
    const failures = buildFailures({
        gates,
        minScheduledRuns,
        scheduledRunAudits,
        enabledCodexDryRunStrategies,
        enabledCodexStrategies,
        codexLiveStrategies,
        runComparison,
        openRouterIsolation,
        targetStrategy: input.targetStrategy,
        targetLlmProvider: targetLlm.provider,
    })

    return {
        exportedAt: input.exportedAt,
        targetStrategy: {
            id: String(input.targetStrategy._id),
            name: input.targetStrategy.name,
            app: input.targetStrategy.app,
            enabled: input.targetStrategy.enabled,
            dryRun: input.targetStrategy.policy.dryRun === true,
            llmProvider: targetLlm.provider,
            llmModel: targetLlm.model,
            llmAuthMode: targetLlm.provider === "codex" ? targetLlm.authMode : undefined,
        },
        evidence: {
            minScheduledRuns,
            scheduledCodexRunIds: scheduledRunAudits.map((audit) => audit.run.id),
            auditedRunIds: input.runAudits.map((audit) => audit.run.id),
            enabledCodexStrategies: enabledCodexStrategies.map((strategy) => ({
                id: strategy.id,
                name: strategy.name,
                app: strategy.app,
                dryRun: strategy.dryRun,
            })),
            codexLiveStrategies: codexLiveStrategies.map((strategy) => ({
                id: strategy.id,
                name: strategy.name,
                app: strategy.app,
                enabled: strategy.enabled,
            })),
            runComparison,
            openRouterIsolation,
        },
        gates,
        failures,
    }
}

function buildRunComparison(args: {
    targetStrategy: StoredStrategy
    runAudits: CodexRunAuditArtifact[]
}): CodexRolloutAuditArtifact["evidence"]["runComparison"] {
    const targetStrategyId = String(args.targetStrategy._id)
    const models = sortedUnique(args.runAudits.map((audit) => audit.run.llmModel ?? "missing"))
    const authModes = sortedUnique(args.runAudits.map((audit) => audit.run.llmAuthMode ?? "missing"))
    const billingModes = sortedUnique(args.runAudits.map((audit) => audit.run.llmBillingMode ?? "missing"))
    const toolNameSets = args.runAudits.map((audit) => ({
        runId: audit.run.id,
        toolNames: audit.evidence.toolNames,
    }))
    const dryRunPositionCounts = args.runAudits.map((audit) => ({
        runId: audit.run.id,
        count: audit.evidence.dryRunPositionCount,
    }))
    const summariesPresent = args.runAudits.map((audit) => ({
        runId: audit.run.id,
        present: typeof audit.run.summary === "string" && audit.run.summary.trim().length > 0,
    }))
    const duplicateRunIds = findDuplicateValues(args.runAudits.map((audit) => audit.run.id))
    const mismatches = [
        ...duplicateRunIds.map((runId) => `Duplicate Codex run audit id ${runId}`),
        ...args.runAudits
            .filter((audit) => audit.strategy.id !== targetStrategyId)
            .map((audit) => `Codex scheduled run ${audit.run.id} belongs to strategy ${audit.strategy.id}, not target strategy ${targetStrategyId}`),
        ...args.runAudits
            .filter((audit) => audit.strategy.app !== args.targetStrategy.app)
            .map((audit) => `Codex scheduled run ${audit.run.id} app ${audit.strategy.app} does not match target app ${args.targetStrategy.app}`),
        ...args.runAudits
            .filter((audit) => audit.strategy.llmProvider !== "codex" || audit.run.llmProvider !== "codex")
            .map((audit) => `Codex scheduled run ${audit.run.id} has provider mismatch strategy=${audit.strategy.llmProvider}, run=${audit.run.llmProvider ?? "missing"}`),
        ...args.runAudits
            .filter((audit) => !audit.strategy.dryRun)
            .map((audit) => `Codex scheduled run ${audit.run.id} audit is not dry-run`),
        ...(models.length > 1 ? [`Codex scheduled runs used multiple models: ${models.join(", ")}`] : []),
        ...(authModes.length > 1 ? [`Codex scheduled runs used multiple auth modes: ${authModes.join(", ")}`] : []),
        ...(billingModes.length > 1 ? [`Codex scheduled runs used multiple billing modes: ${billingModes.join(", ")}`] : []),
        ...summariesPresent
            .filter((summary) => !summary.present)
            .map((summary) => `Codex scheduled run ${summary.runId} has no summary`),
        ...toolNameSets
            .filter((toolSet) => toolSet.toolNames.length === 0)
            .map((toolSet) => `Codex scheduled run ${toolSet.runId} has no shared tool log names`),
        ...args.runAudits
            .filter((audit) => audit.evidence.dryRunAccounting.mismatches.length > 0)
            .map((audit) => `Codex scheduled run ${audit.run.id} has dry-run accounting mismatches`),
    ]

    return {
        models,
        authModes,
        billingModes,
        toolNameSets,
        dryRunPositionCounts,
        summariesPresent,
        mismatches,
    }
}

function buildOpenRouterIsolation(args: {
    samples: CodexRolloutOpenRouterSample[]
    rolloutStartedAt?: number
    enabledOpenRouterStrategies: Array<{ id: string, name: string }>
}): CodexRolloutAuditArtifact["evidence"]["openRouterIsolation"] {
    const mismatches: string[] = []
    let sampledRunCount = 0
    const sampledStrategyIds = new Set(args.samples.map((sample) => String(sample.strategy._id)))
    const enabledOpenRouterStrategyIds = new Set(args.enabledOpenRouterStrategies.map((strategy) => strategy.id))

    for (const strategy of args.enabledOpenRouterStrategies) {
        if (!sampledStrategyIds.has(strategy.id)) {
            mismatches.push(`Enabled OpenRouter strategy ${strategy.name} (${strategy.id}) is missing from rollout isolation samples`)
        }
    }

    for (const sample of args.samples) {
        const llm = resolveStrategyLlmConfig(sample.strategy.policy)
        if (llm.provider !== "openrouter") {
            mismatches.push(`OpenRouter isolation sample ${sample.strategy.name} resolved provider ${llm.provider}`)
        }

        const relevantRuns = args.rolloutStartedAt === undefined
            ? sample.runs
            : sample.runs.filter((run) => run.startedAt >= args.rolloutStartedAt!)
        sampledRunCount += relevantRuns.length

        if (
            args.rolloutStartedAt !== undefined &&
            sample.strategy.enabled &&
            enabledOpenRouterStrategyIds.has(String(sample.strategy._id)) &&
            relevantRuns.length === 0
        ) {
            mismatches.push(`Enabled OpenRouter strategy ${sample.strategy.name} (${sample.strategy._id}) has no run sample at or after Codex rollout start ${args.rolloutStartedAt}`)
        }

        for (const run of relevantRuns) {
            if (run.llmProvider === "codex") {
                mismatches.push(`OpenRouter strategy ${sample.strategy.name} has Codex run ${run._id}`)
            }
            if (run.codexThreadId || (run.codexTurnIds ?? []).length > 0) {
                mismatches.push(`OpenRouter strategy ${sample.strategy.name} run ${run._id} has Codex diagnostics`)
            }
        }
    }

    return {
        strategyCount: args.samples.length,
        enabledStrategyCount: args.enabledOpenRouterStrategies.length,
        sampledRunCount,
        rolloutStartedAt: args.rolloutStartedAt,
        mismatches,
    }
}

function buildFailures(args: {
    gates: CodexRolloutAuditArtifact["gates"]
    minScheduledRuns: number
    scheduledRunAudits: CodexRunAuditArtifact[]
    enabledCodexDryRunStrategies: Array<{ id: string, name: string }>
    enabledCodexStrategies: Array<{ id: string, name: string, dryRun: boolean }>
    codexLiveStrategies: Array<{ id: string, name: string }>
    runComparison: CodexRolloutAuditArtifact["evidence"]["runComparison"]
    openRouterIsolation: CodexRolloutAuditArtifact["evidence"]["openRouterIsolation"]
    targetStrategy: StoredStrategy
    targetLlmProvider: string
}): string[] {
    const failures: string[] = []

    if (!args.gates.targetStrategyIsCodexDryRun) {
        failures.push(`Target strategy ${args.targetStrategy.name} is not a Codex dry-run strategy: provider=${args.targetLlmProvider}, dryRun=${args.targetStrategy.policy.dryRun === true}`)
    }
    if (!args.gates.singleEnabledCodexDryRunStrategy) {
        failures.push(`Expected exactly one enabled Codex dry-run strategy matching ${args.targetStrategy._id}, got ${args.enabledCodexDryRunStrategies.map((strategy) => `${strategy.name} (${strategy.id})`).join(", ") || "none"}`)
        const enabledLiveCodex = args.enabledCodexStrategies.filter((strategy) => !strategy.dryRun)
        if (enabledLiveCodex.length > 0) {
            failures.push(`Enabled Codex live strategies are not allowed during rollout: ${enabledLiveCodex.map((strategy) => `${strategy.name} (${strategy.id})`).join(", ")}`)
        }
    }
    if (!args.gates.liveCodexExecutionBlocked) {
        failures.push(`Live Codex execution is not blocked for all strategies: ${args.codexLiveStrategies.map((strategy) => `${strategy.name} (${strategy.id})`).join(", ") || "run audit included a live Codex strategy"}`)
    }
    if (!args.gates.scheduledCodexRunCount) {
        failures.push(`Expected at least ${args.minScheduledRuns} scheduled Codex dry-run audits, got ${args.scheduledRunAudits.length}`)
    }
    if (!args.gates.codexRunAuditsPass) {
        failures.push(...args.scheduledRunAudits
            .filter((audit) => audit.failures.length > 0)
            .map((audit) => `Codex scheduled run ${audit.run.id} failed audit gates: ${audit.failures.join(" | ")}`))
    }
    if (!args.gates.codexRunsComparable) {
        failures.push(...args.runComparison.mismatches.map((mismatch) => `Codex rollout comparison failed: ${mismatch}`))
    }
    if (!args.gates.openRouterProviderIsolation) {
        failures.push(...args.openRouterIsolation.mismatches.map((mismatch) => `OpenRouter isolation failed: ${mismatch}`))
    }

    return failures
}

function sortedUnique(values: string[]): string[] {
    return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right))
}

function findDuplicateValues(values: string[]): string[] {
    const seen = new Set<string>()
    const duplicates = new Set<string>()

    for (const value of values) {
        if (seen.has(value)) {
            duplicates.add(value)
        }
        seen.add(value)
    }

    return Array.from(duplicates).sort((left, right) => left.localeCompare(right))
}

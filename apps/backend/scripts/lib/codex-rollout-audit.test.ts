import { describe, expect, it } from "vitest"
import type {
    Id,
    StoredRun,
    StoredStrategy,
} from "@valiq-trading/convex"
import type { CodexRunAuditArtifact } from "./codex-run-audit"
import { buildCodexRolloutAuditArtifact } from "./codex-rollout-audit"

describe("buildCodexRolloutAuditArtifact", () => {
    it("accepts three scheduled Codex dry-run audits with OpenRouter isolation", () => {
        const codexStrategy = createStrategy({
            id: "strategy-codex",
            provider: "codex",
            dryRun: true,
            enabled: true,
        })
        const openRouterStrategy = createStrategy({
            id: "strategy-openrouter",
            provider: "openrouter",
            dryRun: false,
            enabled: true,
        })
        const artifact = buildCodexRolloutAuditArtifact({
            exportedAt: "2026-06-08T12:00:00.000Z",
            targetStrategy: codexStrategy,
            allStrategies: [
                codexStrategy,
                openRouterStrategy,
            ],
            runAudits: [
                createRunAudit("run-1", 1000),
                createRunAudit("run-2", 2000),
                createRunAudit("run-3", 3000),
            ],
            openRouterSamples: [{
                strategy: openRouterStrategy,
                runs: [createOpenRouterRun("openrouter-run-1", 1500)],
            }],
        })

        expect(artifact.failures).toEqual([])
        expect(artifact.gates).toEqual({
            targetStrategyIsCodexDryRun: true,
            singleEnabledCodexDryRunStrategy: true,
            liveCodexExecutionBlocked: true,
            scheduledCodexRunCount: true,
            codexRunAuditsPass: true,
            codexRunsComparable: true,
            openRouterProviderIsolation: true,
        })
        expect(artifact.evidence.scheduledCodexRunIds).toEqual(["run-1", "run-2", "run-3"])
        expect(artifact.evidence.openRouterIsolation).toMatchObject({
            strategyCount: 1,
            enabledStrategyCount: 1,
            sampledRunCount: 1,
            mismatches: [],
        })
    })

    it("fails closed when enabled OpenRouter strategies have no post-rollout run sample", () => {
        const codexStrategy = createStrategy({
            id: "strategy-codex",
            provider: "codex",
            dryRun: true,
            enabled: true,
        })
        const openRouterStrategy = createStrategy({
            id: "strategy-openrouter",
            provider: "openrouter",
            dryRun: false,
            enabled: true,
        })
        const artifact = buildCodexRolloutAuditArtifact({
            exportedAt: "2026-06-08T12:00:00.000Z",
            targetStrategy: codexStrategy,
            allStrategies: [
                codexStrategy,
                openRouterStrategy,
            ],
            runAudits: [
                createRunAudit("run-1", 1000),
                createRunAudit("run-2", 2000),
                createRunAudit("run-3", 3000),
            ],
            openRouterSamples: [{
                strategy: openRouterStrategy,
                runs: [createOpenRouterRun("openrouter-run-before-rollout", 500)],
            }],
        })

        expect(artifact.gates.openRouterProviderIsolation).toBe(false)
        expect(artifact.evidence.openRouterIsolation.sampledRunCount).toBe(0)
        expect(artifact.failures).toEqual(expect.arrayContaining([
            expect.stringContaining("has no run sample at or after Codex rollout start 1000"),
        ]))
    })

    it("fails closed when rollout evidence is incomplete or provider isolation is broken", () => {
        const codexStrategy = createStrategy({
            id: "strategy-codex",
            provider: "codex",
            dryRun: true,
            enabled: true,
        })
        const secondCodexStrategy = createStrategy({
            id: "strategy-codex-two",
            provider: "codex",
            dryRun: true,
            enabled: true,
        })
        const liveCodexStrategy = createStrategy({
            id: "strategy-codex-live",
            provider: "codex",
            dryRun: false,
            enabled: false,
        })
        const openRouterStrategy = createStrategy({
            id: "strategy-openrouter",
            provider: "openrouter",
            dryRun: false,
            enabled: true,
        })
        const artifact = buildCodexRolloutAuditArtifact({
            exportedAt: "2026-06-08T12:00:00.000Z",
            targetStrategy: codexStrategy,
            allStrategies: [
                codexStrategy,
                secondCodexStrategy,
                liveCodexStrategy,
                openRouterStrategy,
            ],
            runAudits: [
                createRunAudit("run-1", 1000),
                createRunAudit("run-2", 2000, {
                    summary: "",
                    toolNames: [],
                    failures: ["single-run audit failed"],
                    strategyId: "wrong-strategy",
                }),
            ],
            openRouterSamples: [{
                strategy: openRouterStrategy,
                runs: [{
                    ...createOpenRouterRun("openrouter-run-1", 1500),
                    llmProvider: "codex",
                    codexThreadId: "thread-openrouter-leak",
                }],
            }],
        })

        expect(artifact.gates.singleEnabledCodexDryRunStrategy).toBe(false)
        expect(artifact.gates.liveCodexExecutionBlocked).toBe(false)
        expect(artifact.gates.scheduledCodexRunCount).toBe(false)
        expect(artifact.gates.codexRunAuditsPass).toBe(false)
        expect(artifact.gates.codexRunsComparable).toBe(false)
        expect(artifact.gates.openRouterProviderIsolation).toBe(false)
        expect(artifact.failures).toEqual(expect.arrayContaining([
            expect.stringContaining("Expected exactly one enabled Codex dry-run strategy"),
            expect.stringContaining("Live Codex execution is not blocked"),
            expect.stringContaining("Expected at least 3 scheduled Codex dry-run audits"),
            expect.stringContaining("Codex scheduled run run-2 failed audit gates"),
            expect.stringContaining("belongs to strategy wrong-strategy"),
            expect.stringContaining("Codex rollout comparison failed"),
            expect.stringContaining("OpenRouter isolation failed"),
        ]))
    })
})

function createStrategy(args: {
    id: string
    provider: "openrouter" | "codex"
    dryRun: boolean
    enabled: boolean
}): StoredStrategy {
    return {
        _id: args.id as Id<"strategies">,
        _creationTime: 1,
        app: "polymarket",
        name: args.id,
        enabled: args.enabled,
        schedule: "*/30 * * * *",
        policy: {
            dryRun: args.dryRun,
            llm: args.provider === "codex"
                ? {
                    provider: "codex",
                    model: "gpt-5.4",
                    authMode: "chatgpt",
                }
                : {
                    provider: "openrouter",
                    model: "openai/gpt-5.4",
                },
        },
        context: "test",
        createdAt: 1,
        updatedAt: 1,
    }
}

function createRunAudit(
    runId: string,
    startedAt: number,
    overrides: {
        summary?: string
        toolNames?: string[]
        failures?: string[]
        strategyId?: string
    } = {}
): CodexRunAuditArtifact {
    const failures = overrides.failures ?? []
    const strategyId = overrides.strategyId ?? "strategy-codex"

    return {
        exportedAt: "2026-06-08T12:00:00.000Z",
        strategy: {
            id: strategyId,
            name: "strategy-codex",
            app: "polymarket",
            dryRun: true,
            llmProvider: "codex",
            llmModel: "gpt-5.4",
            llmAuthMode: "chatgpt",
        },
        run: {
            id: runId,
            status: "completed",
            trigger: "cron",
            startedAt,
            endedAt: startedAt + 100,
            summary: overrides.summary ?? `summary ${runId}`,
            llmProvider: "codex",
            llmModel: "gpt-5.4",
            llmAuthMode: "chatgpt",
            llmBillingMode: "codex-subscription",
            codexThreadId: `thread-${runId}`,
            codexTurnIds: [`turn-${runId}`],
            hasRateLimitBefore: true,
            hasRateLimitAfter: true,
        },
        evidence: {
            toolLogCount: (overrides.toolNames ?? ["get_account"]).length,
            toolNames: overrides.toolNames ?? ["get_account"],
            nonCanonicalToolNames: [],
            tradeEventCount: 1,
            dryRunPositionCount: 1,
            hasDryRunLedger: true,
            dryRunLedgerSourceRunId: runId,
            providerSync: {
                app: "polymarket",
                lastSyncedAt: startedAt + 100,
                lastVerifiedAt: startedAt + 100,
                providerStatus: "healthy",
                stale: false,
                driftDetected: false,
            },
            providerSyncAudit: {
                referenceTimestamp: startedAt + 100,
                syncedAfterRun: true,
                verifiedAfterRun: true,
                mismatches: [],
            },
            dryRunAccounting: {
                ledger: {
                    cashAdjustment: -1,
                    realizedPnl: 0,
                    balance: 999,
                    equity: 1000,
                    openPnl: 0,
                    dayPnl: 0,
                },
                recomputed: {
                    cashAdjustment: -1,
                    realizedPnl: 0,
                    balance: 999,
                    equity: 1000,
                    openPnl: 0,
                    dayPnl: 0,
                },
                mismatches: [],
            },
            evidenceLinkage: {
                mismatches: [],
            },
        },
        gates: {
            providerIdentityIsCodex: failures.length === 0,
            evidenceRowsMatchRun: failures.length === 0,
            dryRunStrategy: failures.length === 0,
            completedRun: failures.length === 0,
            toolLogsFromSharedEngine: failures.length === 0,
            noForbiddenToolRan: failures.length === 0,
            canonicalRunToolsOnly: failures.length === 0,
            dryRunAccountingMatchesRun: failures.length === 0,
            providerSyncHealthy: failures.length === 0,
        },
        failures,
    }
}

function createOpenRouterRun(runId: string, startedAt: number): StoredRun {
    return {
        _id: runId as Id<"strategy_runs">,
        _creationTime: startedAt,
        strategyId: "strategy-openrouter" as Id<"strategies">,
        app: "polymarket",
        status: "completed",
        trigger: "cron",
        startedAt,
        endedAt: startedAt + 100,
        summary: "openrouter complete",
        llmProvider: "openrouter",
        llmModel: "openai/gpt-5.4",
    }
}

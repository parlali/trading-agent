import { describe, expect, it } from "vitest"
import type {
    AgentLogRow,
    PortfolioFreshnessRow,
    StoredRun,
    StoredStrategy,
    TradeEventRow,
} from "@valiq-trading/convex"
import type { Id } from "@valiq-trading/convex"
import type { Position } from "@valiq-trading/core"
import { DRY_RUN_ACCOUNT_LEDGER_INSTRUMENT } from "@valiq-trading/core"
import { buildCodexRunAuditArtifact } from "./codex-run-audit"

describe("buildCodexRunAuditArtifact", () => {
    it("accepts a complete Codex dry-run export with shared tool logs and healthy provider sync", () => {
        const artifact = buildCodexRunAuditArtifact({
            exportedAt: "2026-06-08T12:00:00.000Z",
            strategy: createStrategy(),
            run: createRun(),
            agentLogs: [
                createAgentLog({
                    role: "tool",
                    toolName: "get_account",
                    toolInput: "{}",
                    toolOutput: "{\"balance\":1000}",
                }),
                createAgentLog({
                    role: "tool",
                    sequence: 2,
                    toolName: "get_breaking_news",
                    toolInput: "{\"window\":\"24h\"}",
                    toolOutput: "{\"articles\":[]}",
                }),
            ],
            tradeEvents: [createTradeEvent()],
            positions: [
                createPosition("TOKEN-YES"),
                createLedgerPosition("run-1"),
            ],
            portfolioFreshness: [createFreshness()],
        })

        expect(artifact.failures).toEqual([])
        expect(artifact.gates).toEqual({
            providerIdentityIsCodex: true,
            evidenceRowsMatchRun: true,
            dryRunStrategy: true,
            completedRun: true,
            toolLogsFromSharedEngine: true,
            noForbiddenToolRan: true,
            canonicalRunToolsOnly: true,
            dryRunAccountingMatchesRun: true,
            providerSyncHealthy: true,
        })
        expect(artifact.evidence).toMatchObject({
            toolLogCount: 2,
            toolNames: ["get_account", "get_breaking_news"],
            nonCanonicalToolNames: [],
            hasDryRunLedger: true,
            dryRunLedgerSourceRunId: "run-1",
            evidenceLinkage: {
                mismatches: [],
            },
            dryRunAccounting: {
                ledger: {
                    cashAdjustment: -0.5,
                    realizedPnl: 0,
                    balance: 999.5,
                    equity: 1000,
                    openPnl: 0,
                    dayPnl: 0,
                },
                recomputed: {
                    cashAdjustment: -0.5,
                    realizedPnl: 0,
                    balance: 999.5,
                    equity: 1000,
                    openPnl: 0,
                    dayPnl: 0,
                },
                mismatches: [],
            },
            providerSync: {
                lastSyncedAt: 3,
                lastVerifiedAt: 3,
                providerStatus: "healthy",
                stale: false,
                driftDetected: false,
            },
            providerSyncAudit: {
                referenceTimestamp: 2,
                syncedAfterRun: true,
                verifiedAfterRun: true,
                mismatches: [],
            },
        })
    })

    it("fails closed when Codex run evidence is incomplete or forbidden tools appear", () => {
        const artifact = buildCodexRunAuditArtifact({
            exportedAt: "2026-06-08T12:00:00.000Z",
            strategy: createStrategy(),
            run: {
                ...createRun(),
                status: "failed",
                error: "Codex attempted forbidden capability",
                llmProvider: "openrouter",
                codexThreadId: undefined,
                codexTurnIds: [],
                llmRateLimitSnapshotBefore: undefined,
                llmRateLimitSnapshotAfter: undefined,
            },
            agentLogs: [
                createAgentLog({
                    role: "tool",
                    toolName: "shell",
                    toolInput: "{\"cmd\":\"date\"}",
                    toolOutput: "{\"output\":\"blocked\"}",
                }),
            ],
            tradeEvents: [],
            positions: [createLedgerPosition("other-run")],
            portfolioFreshness: [{
                ...createFreshness(),
                providerStatus: "degraded",
                stale: true,
                driftDetected: true,
                lastError: "drift",
            }],
        })

        expect(artifact.failures).toEqual(expect.arrayContaining([
            expect.stringContaining("Expected Codex provider identity"),
            expect.stringContaining("Codex thread id is missing"),
            expect.stringContaining("Run did not complete cleanly"),
            expect.stringContaining("Forbidden Codex tool names"),
            expect.stringContaining("Dry-run ledger does not prove this run"),
            expect.stringContaining("Provider-sync gate failed"),
        ]))
        expect(Object.values(artifact.gates).every((value) => value === true)).toBe(false)
    })

    it("fails closed when tool logs are not canonical strategy tools", () => {
        const artifact = buildCodexRunAuditArtifact({
            exportedAt: "2026-06-08T12:00:00.000Z",
            strategy: createStrategy(),
            run: createRun(),
            agentLogs: [
                createAgentLog({
                    role: "tool",
                    toolName: "codex_apps__github",
                    toolInput: "{\"query\":\"repo\"}",
                    toolOutput: "{\"result\":\"blocked\"}",
                }),
            ],
            tradeEvents: [createTradeEvent()],
            positions: [
                createPosition("TOKEN-YES"),
                createLedgerPosition("run-1"),
            ],
            portfolioFreshness: [createFreshness()],
        })

        expect(artifact.gates.noForbiddenToolRan).toBe(true)
        expect(artifact.gates.canonicalRunToolsOnly).toBe(false)
        expect(artifact.evidence.nonCanonicalToolNames).toEqual(["codex_apps__github"])
        expect(artifact.failures).toEqual(expect.arrayContaining([
            expect.stringContaining("Non-canonical Codex tool names appeared in agent logs: codex_apps__github"),
        ]))
    })

    it("fails closed when run and evidence rows do not belong together", () => {
        const artifact = buildCodexRunAuditArtifact({
            exportedAt: "2026-06-08T12:00:00.000Z",
            strategy: createStrategy(),
            run: {
                ...createRun(),
                strategyId: "other-strategy" as Id<"strategies">,
            },
            agentLogs: [
                createAgentLog({
                    role: "tool",
                    runId: "other-run" as Id<"strategy_runs">,
                    toolName: "get_account",
                    toolInput: "{}",
                    toolOutput: "{\"balance\":1000}",
                }),
            ],
            tradeEvents: [
                createTradeEvent({
                    strategyId: "other-strategy" as Id<"strategies">,
                    app: "okx-swap",
                }),
            ],
            positions: [
                createPosition("TOKEN-YES"),
                createLedgerPosition("run-1"),
            ],
            portfolioFreshness: [createFreshness()],
        })

        expect(artifact.gates.evidenceRowsMatchRun).toBe(false)
        expect(artifact.evidence.evidenceLinkage.mismatches).toEqual(expect.arrayContaining([
            expect.stringContaining("run strategyId other-strategy does not match strategy strategy-1"),
            expect.stringContaining("agent log log-1 runId other-run does not match run run-1"),
            expect.stringContaining("trade event event-1 strategyId other-strategy does not match strategy strategy-1"),
            expect.stringContaining("trade event event-1 app okx-swap does not match run app polymarket"),
        ]))
        expect(artifact.failures).toEqual(expect.arrayContaining([
            expect.stringContaining("Audit evidence linkage failed"),
        ]))
    })

    it("fails closed when the dry-run ledger does not match persisted positions", () => {
        const artifact = buildCodexRunAuditArtifact({
            exportedAt: "2026-06-08T12:00:00.000Z",
            strategy: createStrategy(),
            run: createRun(),
            agentLogs: [
                createAgentLog({
                    role: "tool",
                    toolName: "get_account",
                    toolInput: "{}",
                    toolOutput: "{\"balance\":1000}",
                }),
            ],
            tradeEvents: [createTradeEvent()],
            positions: [
                createPosition("TOKEN-YES"),
                createLedgerPosition("run-1", {
                    cashAdjustment: 0,
                    realizedPnl: 0,
                    balance: 1000,
                    equity: 1000,
                    openPnl: 0,
                    dayPnl: 0,
                }),
            ],
            portfolioFreshness: [createFreshness()],
        })

        expect(artifact.gates.dryRunAccountingMatchesRun).toBe(false)
        expect(artifact.evidence.dryRunAccounting.mismatches).toEqual(expect.arrayContaining([
            expect.stringContaining("ledger metadata equity=1000 does not match recomputed equity=1000.5"),
        ]))
        expect(artifact.failures).toEqual(expect.arrayContaining([
            expect.stringContaining("Dry-run accounting mismatch"),
        ]))
    })

    it("fails closed when provider-sync evidence predates the audited run", () => {
        const artifact = buildCodexRunAuditArtifact({
            exportedAt: "2026-06-08T12:00:00.000Z",
            strategy: createStrategy(),
            run: createRun(),
            agentLogs: [
                createAgentLog({
                    role: "tool",
                    toolName: "get_account",
                    toolInput: "{}",
                    toolOutput: "{\"balance\":1000}",
                }),
            ],
            tradeEvents: [createTradeEvent()],
            positions: [
                createPosition("TOKEN-YES"),
                createLedgerPosition("run-1"),
            ],
            portfolioFreshness: [{
                ...createFreshness(),
                lastSyncedAt: 1,
                lastVerifiedAt: 1,
            }],
        })

        expect(artifact.gates.providerSyncHealthy).toBe(false)
        expect(artifact.evidence.providerSyncAudit).toMatchObject({
            referenceTimestamp: 2,
            syncedAfterRun: false,
            verifiedAfterRun: false,
        })
        expect(artifact.failures).toEqual(expect.arrayContaining([
            expect.stringContaining("lastSyncedAt 1 is before run reference 2"),
            expect.stringContaining("lastVerifiedAt 1 is before run reference 2"),
        ]))
    })
})

function createStrategy(): StoredStrategy {
    return {
        _id: "strategy-1" as Id<"strategies">,
        _creationTime: 1,
        app: "polymarket",
        name: "Codex Dry Run Strategy",
        enabled: true,
        schedule: "*/30 * * * *",
        policy: {
            dryRun: true,
            llm: {
                provider: "codex",
                model: "gpt-5.4",
                authMode: "chatgpt",
            },
        },
        context: "test",
        createdAt: 1,
        updatedAt: 1,
    }
}

function createRun(): StoredRun {
    return {
        _id: "run-1" as Id<"strategy_runs">,
        _creationTime: 1,
        strategyId: "strategy-1" as Id<"strategies">,
        app: "polymarket",
        status: "completed",
        trigger: "manual",
        startedAt: 1,
        endedAt: 2,
        summary: "complete",
        llmProvider: "codex",
        llmModel: "gpt-5.4",
        llmAuthMode: "chatgpt",
        llmBillingMode: "codex-subscription",
        llmResponseIds: [],
        codexThreadId: "thread-1",
        codexTurnIds: ["turn-1"],
        llmRateLimitSnapshotBefore: { before: true },
        llmRateLimitSnapshotAfter: { after: true },
    }
}

function createAgentLog(overrides: Partial<AgentLogRow>): AgentLogRow {
    return {
        _id: "log-1" as Id<"agent_logs">,
        _creationTime: 1,
        runId: "run-1" as Id<"strategy_runs">,
        strategyId: "strategy-1" as Id<"strategies">,
        sequence: 1,
        role: "assistant",
        content: "content",
        timestamp: 1,
        ...overrides,
    }
}

function createTradeEvent(overrides: Partial<TradeEventRow> = {}): TradeEventRow {
    return {
        _id: "event-1" as Id<"trade_events">,
        _creationTime: 1,
        runId: "run-1" as Id<"strategy_runs">,
        strategyId: "strategy-1" as Id<"strategies">,
        app: "polymarket",
        eventType: "submission",
        payload: "{}",
        timestamp: 1,
        ...overrides,
    }
}

function createPosition(instrument: string): Position {
    return {
        instrument,
        side: "long",
        quantity: 1,
        entryPrice: 0.5,
        currentPrice: 0.5,
    }
}

function createLedgerPosition(
    sourceRunId: string,
    metadata: Record<string, unknown> = {
        cashAdjustment: -0.5,
        realizedPnl: 0,
        balance: 999.5,
        equity: 1000,
        openPnl: 0,
        dayPnl: 0,
    }
): Position {
    return {
        instrument: DRY_RUN_ACCOUNT_LEDGER_INSTRUMENT,
        side: "long",
        quantity: 0,
        entryPrice: 0,
        currentPrice: 0,
        metadata: {
            dryRunLedger: true,
            sourceRunId,
            ...metadata,
        },
    }
}

function createFreshness(): PortfolioFreshnessRow {
    return {
        app: "polymarket",
        accountScope: "single-account-per-venue",
        lastSyncedAt: 3,
        lastVerifiedAt: 3,
        providerStatus: "healthy",
        stale: false,
        driftDetected: false,
        positionCount: 0,
        pendingOrderCount: 0,
    }
}

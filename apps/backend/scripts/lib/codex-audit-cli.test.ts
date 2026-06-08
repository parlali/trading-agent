import { describe, expect, it, vi } from "vitest"
import type {
    AgentLogRow,
    Id,
    PortfolioFreshnessRow,
    StoredRun,
    StoredStrategy,
    TradeEventRow,
    TradingBackendClient,
} from "@valiq-trading/convex"
import {
    createDryRunAccountLedgerPosition,
    type Position,
} from "@valiq-trading/core"
import {
    collectCodexRunAuditArtifact,
    resolveAuditOutputPath,
    resolveCodexStrategyAndRun,
    resolveLatestCompletedCodexRun,
    resolveProviderSyncRefreshStrategy,
    resolveStrategySelection,
} from "./codex-audit-cli"

describe("Codex audit CLI helpers", () => {
    it("resolves strategies by id or name", async () => {
        const strategy = createStrategy("strategy-1", "Codex Dry Run")
        const client = {
            getStrategyById: vi.fn().mockResolvedValue(strategy),
            getAllStrategies: vi.fn().mockResolvedValue([strategy]),
        } as unknown as TradingBackendClient

        await expect(resolveStrategySelection(client, {
            strategyId: "strategy-1",
        })).resolves.toBe(strategy)
        await expect(resolveStrategySelection(client, {
            strategyName: "codex dry run",
        })).resolves.toBe(strategy)

        expect(client.getStrategyById).toHaveBeenCalledWith("strategy-1")
        expect(client.getAllStrategies).toHaveBeenCalledOnce()
    })

    it("selects the latest completed Codex run from history", async () => {
        const strategy = createStrategy("strategy-1", "Codex Dry Run")
        const latestCodexRun = createRun("run-codex-latest", "completed", "codex")
        const client = {
            getRunHistory: vi.fn().mockResolvedValue([
                createRun("run-openrouter", "completed", "openrouter"),
                latestCodexRun,
                createRun("run-codex-failed", "failed", "codex"),
            ]),
        } as unknown as TradingBackendClient

        await expect(resolveLatestCompletedCodexRun(client, strategy)).resolves.toBe(latestCodexRun)
    })

    it("rejects run-id selection when explicit strategy args do not match", async () => {
        const originalArgv = process.argv
        const strategy = createStrategy("strategy-1", "Codex Dry Run")
        const run = createRun("run-1", "completed", "codex")
        const client = {
            getRunById: vi.fn().mockResolvedValue(run),
            getStrategyById: vi.fn().mockResolvedValue(strategy),
        } as unknown as TradingBackendClient
        process.argv = [
            "bun",
            "codex-run-audit-export.ts",
            "--run-id",
            "run-1",
            "--strategy",
            "other-strategy",
        ]

        try {
            await expect(resolveCodexStrategyAndRun(client)).rejects.toThrow("belongs to strategy strategy-1")
        } finally {
            process.argv = originalArgv
        }
    })

    it("resolves default and explicit audit output paths", () => {
        expect(resolveAuditOutputPath({
            defaultFileName: "artifact.json",
        })).toContain("private/audits/artifact.json")
        expect(resolveAuditOutputPath({
            outputArg: "private/custom.json",
            defaultFileName: "artifact.json",
        })).toContain("private/custom.json")
    })

    it("collects run audit artifacts from run-specific positions", async () => {
        const strategy = createStrategy("strategy-1", "Codex Dry Run")
        const run: StoredRun = {
            ...createRun("run-1", "completed", "codex"),
            llmAuthMode: "chatgpt",
            llmBillingMode: "usage",
            codexThreadId: "thread-1",
            codexTurnIds: ["turn-1"],
            llmRateLimitSnapshotBefore: {},
            llmRateLimitSnapshotAfter: {},
        }
        const openPosition: Position = {
            instrument: "TOKEN-YES",
            side: "long",
            quantity: 1,
            entryPrice: 0.5,
            currentPrice: 0.5,
        }
        const positions = [
            openPosition,
            createDryRunAccountLedgerPosition({
                policy: strategy.policy,
                positions: [openPosition],
                cashAdjustment: -0.5,
                realizedPnl: 0,
                runId: String(run._id),
            }),
        ]
        const agentLogs: AgentLogRow[] = [{
            _id: "log-1" as Id<"agent_logs">,
            _creationTime: 1,
            runId: run._id,
            strategyId: strategy._id,
            sequence: 1,
            role: "tool",
            content: "tool result",
            toolName: "get_account",
            toolInput: "{}",
            toolOutput: "{\"balance\":1000}",
            timestamp: 2,
        }]
        const tradeEvents: TradeEventRow[] = [{
            _id: "event-1" as Id<"trade_events">,
            _creationTime: 1,
            runId: run._id,
            strategyId: strategy._id,
            app: "polymarket",
            eventType: "submission",
            payload: "{\"status\":\"filled\"}",
            timestamp: 2,
        }]
        const portfolioFreshness: PortfolioFreshnessRow[] = [{
            app: "polymarket",
            accountScope: "single-account-per-venue",
            lastSyncedAt: 3,
            lastVerifiedAt: 3,
            providerStatus: "healthy",
            stale: false,
            driftDetected: false,
            positionCount: 0,
            pendingOrderCount: 0,
        }]
        const client = {
            getAgentLogs: vi.fn().mockResolvedValue(agentLogs),
            getTradeEvents: vi.fn().mockResolvedValue(tradeEvents),
            getPositionsForRun: vi.fn().mockResolvedValue(positions),
            getLatestPositions: vi.fn(),
            getPortfolioFreshness: vi.fn().mockResolvedValue(portfolioFreshness),
        } as unknown as TradingBackendClient

        const artifact = await collectCodexRunAuditArtifact({
            client,
            strategy,
            run,
            exportedAt: "2026-06-08T12:00:00.000Z",
        })

        expect(client.getPositionsForRun).toHaveBeenCalledWith(strategy._id, run._id)
        expect(client.getLatestPositions).not.toHaveBeenCalled()
        expect(artifact.failures).toEqual([])
        expect(artifact.gates.dryRunAccountingMatchesRun).toBe(true)
    })

    it("selects the only same-venue live strategy for provider-sync refresh", () => {
        const targetStrategy = createStrategy("strategy-codex", "Codex Dry Run")
        const liveStrategy = createStrategy("strategy-live", "Live Polymarket", {
            dryRun: false,
        })

        expect(resolveProviderSyncRefreshStrategy({
            targetStrategy,
            allStrategies: [
                targetStrategy,
                liveStrategy,
            ],
        })).toBe(liveStrategy)
    })

    it("requires explicit provider-sync strategy selection when live candidates are ambiguous", () => {
        const targetStrategy = createStrategy("strategy-codex", "Codex Dry Run")
        const liveOne = createStrategy("strategy-live-one", "Live One", {
            dryRun: false,
        })
        const liveTwo = createStrategy("strategy-live-two", "Live Two", {
            dryRun: false,
        })

        expect(() => resolveProviderSyncRefreshStrategy({
            targetStrategy,
            allStrategies: [
                targetStrategy,
                liveOne,
                liveTwo,
            ],
        })).toThrow("Multiple live polymarket strategies")
        expect(resolveProviderSyncRefreshStrategy({
            targetStrategy,
            allStrategies: [
                targetStrategy,
                liveOne,
                liveTwo,
            ],
            providerSyncStrategyId: "strategy-live-two",
        })).toBe(liveTwo)
    })

    it("rejects dry-run or wrong-venue provider-sync refresh strategies", () => {
        const targetStrategy = createStrategy("strategy-codex", "Codex Dry Run")
        const wrongVenue = createStrategy("strategy-okx", "Live OKX", {
            app: "okx-swap",
            dryRun: false,
        })

        expect(() => resolveProviderSyncRefreshStrategy({
            targetStrategy,
            allStrategies: [
                targetStrategy,
            ],
            providerSyncStrategyId: "strategy-codex",
        })).toThrow("is dry-run")
        expect(() => resolveProviderSyncRefreshStrategy({
            targetStrategy,
            allStrategies: [
                targetStrategy,
                wrongVenue,
            ],
            providerSyncStrategyId: "strategy-okx",
        })).toThrow("not target app polymarket")
    })
})

function createStrategy(
    id: string,
    name: string,
    options: {
        app?: StoredStrategy["app"]
        dryRun?: boolean
    } = {}
): StoredStrategy {
    return {
        _id: id as Id<"strategies">,
        _creationTime: 1,
        app: options.app ?? "polymarket",
        name,
        enabled: true,
        schedule: "*/30 * * * *",
        policy: {
            dryRun: options.dryRun ?? true,
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

function createRun(
    id: string,
    status: StoredRun["status"],
    provider: "openrouter" | "codex"
): StoredRun {
    return {
        _id: id as Id<"strategy_runs">,
        _creationTime: 1,
        strategyId: "strategy-1" as Id<"strategies">,
        app: "polymarket",
        status,
        trigger: "cron",
        startedAt: 1,
        endedAt: 2,
        summary: "complete",
        llmProvider: provider,
        llmModel: provider === "codex" ? "gpt-5.4" : "openai/gpt-5.4",
    }
}

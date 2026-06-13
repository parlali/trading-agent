import { afterEach, describe, expect, it, vi } from "vitest"
import type { AgentRunResult } from "@valiq-trading/agent"
import type { StoredStrategy } from "@valiq-trading/convex"
import type { AccountState, Position, VenueAdapter } from "@valiq-trading/core"
import type { VenuePlugin } from "./types"

describe("scheduler runner Codex dry-run side effects", () => {
    afterEach(() => {
        vi.restoreAllMocks()
        vi.resetModules()
        vi.doUnmock("@valiq-trading/agent")
        vi.doUnmock("./scheduler-tool-pool")
        vi.doUnmock("@valiq-trading/convex")
        vi.doUnmock("./state")
        vi.doUnmock("./provider-sync")
    })

    it("runs post-run hooks and syncs dry-run positions after a successful Codex dry-run", async () => {
        const events: string[] = []
        const storedPosition: Position = {
            instrument: "POLYMARKET:market:yes",
            side: "long",
            quantity: 3,
            entryPrice: 0.42,
            currentPrice: 0.45,
        }
        const backend = createBackendMock([storedPosition], events)
        const executeAgentRun = vi.fn(async (): Promise<AgentRunResult> => {
            events.push("agent")
            return createAgentRunResult()
        })
        const reconcileProviderPortfolio = vi.fn(async () => ({
            app: "polymarket",
            source: "post_run_sync",
            positionCount: 0,
            pendingOrderCount: 0,
            driftDetected: false,
        }))

        vi.doMock("@valiq-trading/agent", () => ({
            ToolRegistry: FakeToolRegistry,
            executeAgentRun,
            withCallBudget: (tool: unknown) => tool,
        }))
        vi.doMock("./scheduler-tool-pool", () => ({
            buildToolPool: () => ({
                forVenue: () => [],
            }),
        }))
        vi.doMock("./codex-auth", () => ({
            inspectCodexChatGptAuthStatusSync: () => ({
                ready: true,
                status: "ready",
                codexHome: "/tmp/codex",
                authFilePath: "/tmp/codex/auth.json",
                accountId: "account-1",
                lastRefresh: "2026-06-09T00:00:00.000Z",
                message: "Codex ChatGPT login is active",
            }),
        }))
        vi.doMock("@valiq-trading/convex", () => ({
            createConvexOrderPersistenceAdapter: () => ({
                listActiveOrders: vi.fn(async () => []),
            }),
        }))
        vi.doMock("./state", () => ({
            backend,
            convexUrl: "http://convex.test",
            backendServiceToken: "backend-token",
            healthState: {
                venues: {
                    polymarket: {
                        validated: true,
                        accounts: {
                            "test-account": {
                                validated: true,
                            },
                        },
                    },
                },
            },
            killSwitchCheckers: {},
            logger: createLoggerMock(),
        }))
        vi.doMock("./provider-sync", () => ({
            reconcileProviderPortfolio,
            recordProviderSyncFailure: vi.fn(async () => undefined),
        }))

        const { runStrategy } = await import("./scheduler-runner")
        const strategy = createStrategy()
        const policy = strategy.policy
        const plugin = createPlugin(events)

        await runStrategy("polymarket", plugin, strategy, policy, {}, undefined, "manual")

        expect(events).toEqual(["agent", "post-run-hooks", "sync-positions"])
        expect(executeAgentRun).toHaveBeenCalledTimes(1)
        const [agentContext, agentConfig] = executeAgentRun.mock.calls[0] as unknown as [
            Record<string, unknown>,
            { provider: Record<string, unknown> },
        ]
        expect(agentContext).toMatchObject({
            strategyId: strategy._id,
            app: "polymarket",
            positions: [storedPosition],
            policy,
        })
        expect(agentConfig.provider).toMatchObject({
            provider: "codex",
            model: "gpt-5.4",
            authMode: "chatgpt",
        })
        expect(backend.syncPositions).toHaveBeenCalledTimes(1)
        const syncCall = backend.syncPositions.mock.calls[0] as unknown as [string, string, Position[]]
        const syncedPositions = syncCall[2]
        expect(syncedPositions.some((position) => position.instrument === storedPosition.instrument)).toBe(true)
        expect(syncedPositions.some((position) => position.metadata?.dryRunLedger === true)).toBe(true)
        expect(reconcileProviderPortfolio).not.toHaveBeenCalled()
        expect(backend.updateRun).toHaveBeenCalledWith(
            "run-1",
            "completed",
            "Codex dry-run completed",
            undefined,
            expect.objectContaining({
                llmProvider: "codex",
                llmModel: "gpt-5.4",
                llmAuthMode: "chatgpt",
            })
        )
    })
})

class FakeToolRegistry {
    readonly tools: unknown[] = []

    register(tool: unknown): void {
        this.tools.push(tool)
    }

    getDescriptions(): unknown[] {
        return this.tools
    }
}

function createBackendMock(storedPositions: Position[], events: string[]) {
    return {
        createAlert: vi.fn(async () => undefined),
        createRun: vi.fn(async () => "run-1"),
        getAllOwnedInstrumentsByApp: vi.fn(async (_app, _accountId) => []),
        getLastCompletedRunSummary: vi.fn(async () => null),
        getLatestPositions: vi.fn(async () => storedPositions),
        getStrategyOrderHistory: vi.fn(async () => []),
        getStrategyOwnershipScope: vi.fn(async () => ({
            instruments: [storedPositions[0]?.instrument].filter((instrument): instrument is string => typeof instrument === "string"),
            positionKeys: [],
            workingOrderIds: [],
        })),
        recordExecutionSafetyFault: vi.fn(async () => undefined),
        recordRunCallback: vi.fn(async () => undefined),
        refreshStrategyRiskState: vi.fn(async () => ({
            strategyId: "strategy-1",
            app: "polymarket",
            safetyState: "healthy",
            day: {
                realizedPnl: 0,
            },
            week: {
                realizedPnl: 0,
            },
            cooldown: {
                active: false,
            },
            unresolvedExecutionFaultCount: 0,
            blockedInstruments: [],
            forcedExitClusterInstruments: [],
            lastUpdatedAt: Date.now(),
        })),
        syncPositions: vi.fn(async () => {
            events.push("sync-positions")
        }),
        updateRun: vi.fn(async () => undefined),
    }
}

function createLoggerMock() {
    const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child: vi.fn(),
    }
    logger.child.mockReturnValue(logger)
    return logger
}

function createPlugin(events: string[]): VenuePlugin {
    const venue = createVenue()
    return {
        app: "polymarket",
        venueName: "Polymarket",
        resolveSecretKeys: () => [],
        validateEnvironment: async () => undefined,
        createVenueAdapter: () => venue,
        getRiskValidators: () => [],
        getExtraTools: async () => [],
        postRunHooks: async () => {
            events.push("post-run-hooks")
        },
    }
}

function createVenue(): VenueAdapter {
    const account: AccountState = {
        balance: 10_000,
        equity: 10_000,
        buyingPower: 10_000,
        marginUsed: 0,
        marginAvailable: 10_000,
        openPnl: 0,
        dayPnl: 0,
    }

    return {
        getPositions: vi.fn(async () => {
            throw new Error("dry-run scheduler path should not read live provider positions")
        }),
        getAccountState: vi.fn(async () => account),
        getWorkingOrders: vi.fn(async () => []),
        submitOrder: vi.fn(async () => rejectedExecutionResult()),
        cancelOrder: vi.fn(async () => rejectedExecutionResult()),
        modifyOrder: vi.fn(async () => rejectedExecutionResult()),
        closePosition: vi.fn(async () => rejectedExecutionResult()),
        getOrderStatus: vi.fn(async () => rejectedExecutionResult()),
    }
}

function rejectedExecutionResult() {
    return {
        orderId: "unused",
        status: "rejected" as const,
        filledQuantity: 0,
        timestamp: Date.now(),
        error: "not exercised",
    }
}

function createStrategy(): StoredStrategy {
    return {
        _id: "strategy-1" as StoredStrategy["_id"],
        _creationTime: 1,
        app: "polymarket",
        accountId: "test-account",
        name: "Codex Dry Run Strategy",
        enabled: true,
        schedule: "*/30 * * * *",
        policy: {
            dryRun: true,
            dryRunInitialCash: 10_000,
            llm: {
                provider: "codex",
                model: "gpt-5.4",
                authMode: "chatgpt",
            },
        },
        context: "Research the configured market and do not place live orders.",
        createdAt: 1,
        updatedAt: 1,
    }
}

function createAgentRunResult(): AgentRunResult {
    return {
        summary: "Codex dry-run completed",
        iterations: 1,
        usage: {
            promptTokens: 11,
            completionTokens: 7,
            reasoningTokens: 0,
            cost: 0,
            responseIds: [],
        },
        opportunityCoverage: {
            researched: 0,
            qualified: 0,
            rejectedByModel: 0,
            rejectedByRisk: 0,
            submitted: 0,
            filled: 0,
            closed: 0,
            realizedPnl: 0,
        },
        providerDiagnostics: {
            provider: "codex",
            model: "gpt-5.4",
            authMode: "chatgpt",
            billingMode: "codex-subscription",
            responseIds: [],
            codexThreadId: "thread-1",
            codexTurnIds: ["turn-1"],
        },
        toolManifest: [],
    }
}

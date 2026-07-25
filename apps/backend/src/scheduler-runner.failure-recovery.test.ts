import { afterEach, describe, expect, it, vi } from "vitest"
import type { AgentRunResult } from "@valiq-trading/agent"
import type { Id, StoredStrategy } from "@valiq-trading/convex"
import type {
    AccountState,
    Position,
    Scheduler,
    VenueAdapter,
} from "@valiq-trading/core"
import type { VenuePlugin } from "./types"

const FIVE_MINUTES_MS = 5 * 60 * 1000
const TEN_MINUTES_MS = 10 * 60 * 1000

describe("scheduler runner failure recovery", () => {
    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
        vi.resetModules()
        vi.doUnmock("@valiq-trading/agent")
        vi.doUnmock("@valiq-trading/convex")
        vi.doUnmock("./scheduler-tool-pool")
        vi.doUnmock("./state")
        vi.doUnmock("./provider-sync")
    })

    it("schedules exactly one recovery oneshot for a failed zero-tool cron run and does not chain from the follow-up", async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date("2026-07-24T10:00:00.000Z"))

        const scheduler = createSchedulerMock()
        const harness = await createRunnerHarness({
            agentResults: [
                { toolCallCount: 0, error: "capacity exhausted" },
                { toolCallCount: 0, error: "capacity exhausted again" },
            ],
        })

        const strategy = createStrategy()
        await harness.runStrategy(
            "okx-swap",
            createPlugin(),
            strategy,
            strategy.policy,
            { OPENROUTER_API_KEY: "test-key" },
            scheduler.scheduler,
            "cron"
        )

        expect(scheduler.scheduleOneshot).toHaveBeenCalledTimes(1)
        expect(scheduler.scheduled[0]?.strategyId).toBe(strategy._id)
        expect(scheduler.scheduled[0]?.delayMs).toBeGreaterThanOrEqual(FIVE_MINUTES_MS)
        expect(scheduler.scheduled[0]?.delayMs).toBeLessThanOrEqual(TEN_MINUTES_MS)
        expect(harness.backend.createAlert).toHaveBeenCalledWith(expect.objectContaining({
            app: "okx-swap",
            severity: "info",
            message: expect.stringContaining("reasons=cheap_failure"),
        }))

        await scheduler.scheduled[0]!.handler()

        expect(harness.executeAgentRun).toHaveBeenCalledTimes(2)
        expect(scheduler.scheduleOneshot).toHaveBeenCalledTimes(1)
        expect(countInfoAlerts(harness.backend.createAlert)).toBe(1)
        expect(harness.backend.createRun).toHaveBeenNthCalledWith(
            2,
            strategy._id,
            "okx-swap",
            "callback",
            undefined
        )
    })

    it("does not schedule recovery for an expensive failed run without open supervision state", async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date("2026-07-24T10:00:00.000Z"))

        const scheduler = createSchedulerMock()
        const harness = await createRunnerHarness({
            agentResults: [
                { toolCallCount: 8, error: "model stopped after research" },
            ],
        })
        const strategy = createStrategy()

        await harness.runStrategy(
            "okx-swap",
            createPlugin(),
            strategy,
            strategy.policy,
            { OPENROUTER_API_KEY: "test-key" },
            scheduler.scheduler,
            "cron"
        )

        expect(scheduler.scheduleOneshot).not.toHaveBeenCalled()
        expect(harness.backend.createAlert).not.toHaveBeenCalledWith(expect.objectContaining({
            severity: "info",
        }))
    })

    it("schedules recovery for an expensive failed run with an open position", async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date("2026-07-24T10:00:00.000Z"))

        const scheduler = createSchedulerMock()
        const position = createPosition()
        const harness = await createRunnerHarness({
            storedPositions: [position],
            agentResults: [
                { toolCallCount: 8, error: "circuit breaker terminated run" },
            ],
        })
        const strategy = createStrategy()

        await harness.runStrategy(
            "okx-swap",
            createPlugin(),
            strategy,
            strategy.policy,
            { OPENROUTER_API_KEY: "test-key" },
            scheduler.scheduler,
            "cron"
        )

        expect(scheduler.scheduleOneshot).toHaveBeenCalledTimes(1)
        expect(scheduler.scheduled[0]?.delayMs).toBeGreaterThanOrEqual(FIVE_MINUTES_MS)
        expect(scheduler.scheduled[0]?.delayMs).toBeLessThanOrEqual(TEN_MINUTES_MS)
        expect(harness.backend.createAlert).toHaveBeenCalledWith(expect.objectContaining({
            app: "okx-swap",
            severity: "info",
            message: expect.stringContaining("reasons=supervision_recovery"),
        }))
    })

    it("suppresses recovery when the follow-up would fire outside trading hours", async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date("2026-07-24T18:00:00.000Z"))

        const scheduler = createSchedulerMock()
        const harness = await createRunnerHarness({
            agentResults: [
                { toolCallCount: 0, error: "capacity exhausted" },
            ],
        })
        const strategy = createStrategy({
            tradingHours: {
                start: "09:00",
                end: "17:00",
                timezone: "UTC",
            },
        })

        await harness.runStrategy(
            "okx-swap",
            createPlugin(),
            strategy,
            strategy.policy,
            { OPENROUTER_API_KEY: "test-key" },
            scheduler.scheduler,
            "cron"
        )

        expect(scheduler.scheduleOneshot).not.toHaveBeenCalled()
        expect(harness.logger.info).toHaveBeenCalledWith(
            "Failure recovery follow-up suppressed",
            expect.objectContaining({
                reason: "outside_trading_hours",
            })
        )
    })
})

interface AgentResultConfig {
    toolCallCount: number
    error?: string
}

interface RunnerHarnessOptions {
    storedPositions?: Position[]
    agentResults: AgentResultConfig[]
}

interface ScheduledOneshot {
    strategyId: string
    delayMs: number
    handler: () => Promise<void>
}

function createSchedulerMock(): {
    scheduler: Scheduler
    scheduleOneshot: ReturnType<typeof vi.fn>
    scheduled: ScheduledOneshot[]
} {
    const scheduled: ScheduledOneshot[] = []
    const scheduleOneshot = vi.fn((strategyId: string, delayMs: number, handler: () => Promise<void>) => {
        scheduled.push({
            strategyId,
            delayMs,
            handler,
        })
    })

    return {
        scheduler: { scheduleOneshot } as unknown as Scheduler,
        scheduleOneshot,
        scheduled,
    }
}

function countInfoAlerts(createAlert: ReturnType<typeof vi.fn>): number {
    return createAlert.mock.calls.filter(([alert]) =>
        (alert as { severity?: string }).severity === "info"
    ).length
}

async function createRunnerHarness(options: RunnerHarnessOptions): Promise<{
    runStrategy: typeof import("./scheduler-runner")["runStrategy"]
    backend: ReturnType<typeof createBackendMock>
    executeAgentRun: ReturnType<typeof vi.fn>
    logger: ReturnType<typeof createLoggerMock>
}> {
    const backend = createBackendMock(options.storedPositions ?? [])
    const logger = createLoggerMock()
    let agentRunIndex = 0
    const executeAgentRun = vi.fn(async (): Promise<AgentRunResult> => {
        const result = options.agentResults[Math.min(agentRunIndex, options.agentResults.length - 1)]!
        agentRunIndex++
        return createAgentRunResult(result)
    })

    vi.doMock("@valiq-trading/agent", () => ({
        ToolRegistry: FakeToolRegistry,
        executeAgentRun,
        withMcpToolCallBudget: (tool: unknown) => tool,
    }))
    vi.doMock("@valiq-trading/convex", () => ({
        createConvexOrderPersistenceAdapter: () => ({
            listActiveOrders: vi.fn(async () => []),
        }),
    }))
    vi.doMock("./scheduler-tool-pool", () => ({
        buildToolPool: () => ({
            forVenue: () => [],
        }),
    }))
    vi.doMock("./state", () => ({
        backend,
        backendServiceToken: "backend-token",
        convexUrl: "http://convex.test",
        healthState: {
            venues: {
                "okx-swap": {
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
        logger,
        syncStrategies: {},
    }))
    vi.doMock("./provider-sync", () => ({
        reconcileProviderPortfolio: vi.fn(async () => ({
            app: "okx-swap",
            source: "post_run_sync",
            positionCount: 0,
            pendingOrderCount: 0,
            driftDetected: false,
        })),
        recordProviderSyncFailure: vi.fn(async () => undefined),
    }))

    const { runStrategy } = await import("./scheduler-runner")

    return {
        runStrategy,
        backend,
        executeAgentRun,
        logger,
    }
}

class FakeToolRegistry {
    private readonly tools: unknown[] = []

    register(tool: unknown): void {
        this.tools.push(tool)
    }

    getDescriptions(): unknown[] {
        return this.tools
    }

    getManifest(): unknown[] {
        return this.tools
    }
}

function createBackendMock(storedPositions: Position[]) {
    let runSequence = 0

    return {
        createAlert: vi.fn(async () => undefined),
        createRun: vi.fn(async () => {
            runSequence++
            return `run-${runSequence}` as Id<"strategy_runs">
        }),
        getAllOwnedInstrumentsByApp: vi.fn(async () => []),
        getApplicableStrategyOperationalMemory: vi.fn(async () => []),
        getLatestPositions: vi.fn(async () => storedPositions),
        getStrategyOrderHistory: vi.fn(async () => []),
        getStrategyOwnershipScope: vi.fn(async () => ({
            instruments: storedPositions.map((position) => position.instrument),
            positionKeys: [],
            workingOrderIds: [],
        })),
        getStrategyMcpToolWhitelist: vi.fn(async () => null),
        getSuiteLossState: vi.fn(async () => ({
            blocked: false,
            dayChangePercent: 0,
            weekChangePercent: 0,
            evaluatedAt: Date.now(),
        })),
        logBatch: vi.fn(async (entries: unknown[]) => entries),
        recordExecutionSafetyFault: vi.fn(async () => undefined),
        recordRunCallback: vi.fn(async () => undefined),
        refreshStrategyOperationalMemoryFromRun: vi.fn(async () => ({ upserted: 0 })),
        refreshStrategyRiskState: vi.fn(async () => ({
            strategyId: "strategy-1",
            app: "okx-swap",
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
        syncPositions: vi.fn(async () => undefined),
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

function createPlugin(): VenuePlugin {
    const venue = createVenue()
    return {
        app: "okx-swap",
        venueName: "okx",
        resolveSecretKeys: () => [],
        validateEnvironment: async () => undefined,
        createVenueAdapter: () => venue,
        getRiskValidators: () => [],
        getExtraTools: async () => [],
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
        getPositions: vi.fn(async () => []),
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

function createStrategy(policyOverrides: Record<string, unknown> = {}): StoredStrategy {
    const policy = {
        dryRun: true,
        dryRunInitialCash: 10_000,
        llm: {
            provider: "openrouter",
            model: "openrouter/test",
        },
        tradingHours: {
            start: "00:00",
            end: "23:59",
            timezone: "UTC",
        },
        safety: {
            strategyTimezone: "UTC",
            sessionFlat: {
                enabled: false,
                closeBufferMinutes: 15,
                timezone: "UTC",
            },
        },
        ...policyOverrides,
    }

    return {
        _id: "strategy-1" as StoredStrategy["_id"],
        _creationTime: 1,
        app: "okx-swap",
        accountId: "test-account",
        name: "Recovery Test Strategy",
        enabled: true,
        schedule: "*/30 * * * *",
        policy,
        context: "Research and manage the configured market.",
        createdAt: 1,
        updatedAt: 1,
    }
}

function createPosition(): Position {
    return {
        instrument: "BTC-USDT-SWAP",
        side: "long",
        quantity: 1,
        entryPrice: 60_000,
        currentPrice: 60_100,
    }
}

function createAgentRunResult(config: AgentResultConfig): AgentRunResult {
    return {
        summary: config.error ? "failed before decision" : "completed",
        error: config.error,
        iterations: 1,
        usage: {
            promptTokens: 10,
            completionTokens: 5,
            reasoningTokens: 0,
            cost: 0,
            responseIds: [],
        },
        opportunityCoverage: {
            researched: 0,
            qualified: 0,
            rejectedByModel: 0,
            rejectedByRisk: 0,
        },
        toolCallCount: config.toolCallCount,
        providerDiagnostics: {
            provider: "openrouter",
            model: "openrouter/test",
            responseIds: [],
        },
        toolManifest: [],
    }
}

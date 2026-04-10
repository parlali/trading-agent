import { beforeEach, describe, expect, it, vi } from "vitest"
import type { StoredStrategy } from "@valiq-trading/convex"
import type { SyncStrategyEntry } from "./state"

const syncStrategies: Partial<Record<string, SyncStrategyEntry[]>> = {}

const mocks = {
    backend: {
        getStrategyConfigs: vi.fn(),
    },
    healthState: {
        ready: false,
        startedAt: 0,
        strategyCount: 0,
        venues: {},
    },
    logger: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    },
    registerStrategyWithScheduler: vi.fn(),
    resolveAllSecrets: vi.fn(),
    resolveStrategyRuntimeState: vi.fn(),
    syncStrategies,
    syncStrategyEntryChanged: vi.fn(),
    upsertSyncStrategyEntry: vi.fn((app: string, entry: SyncStrategyEntry) => {
        syncStrategies[app] ??= []
        const index = syncStrategies[app]!.findIndex(
            (candidate) => candidate.strategy._id === entry.strategy._id
        )

        if (index === -1) {
            syncStrategies[app]!.push(entry)
            return
        }

        syncStrategies[app]![index] = entry
    }),
}

vi.mock("./state", () => ({
    ALL_APPS: ["alpaca-options", "polymarket", "mt5"],
    PERIODIC_SYNC_INTERVAL_MS: 300_000,
    backend: mocks.backend,
    healthState: mocks.healthState,
    logger: mocks.logger,
    plugins: {},
    syncStrategies: mocks.syncStrategies,
    periodicSyncInFlight: false,
    periodicSyncTimer: null,
    setPeriodicSyncInFlight: vi.fn(),
    setPeriodicSyncTimer: vi.fn(),
}))

vi.mock("./required-apps", () => ({
    getRequiredVenueApps: vi.fn(() => []),
}))

vi.mock("./plugins/init", () => ({
    resolveAllSecrets: mocks.resolveAllSecrets,
    validateAllEnvironments: vi.fn(),
}))

vi.mock("./provider-sync", () => ({
    getProviderSyncConfig: vi.fn(),
    reconcileProviderPortfolio: vi.fn(),
    recordProviderSyncFailure: vi.fn(),
}))

vi.mock("./scheduler", () => ({
    registerStrategyWithScheduler: mocks.registerStrategyWithScheduler,
    resolveStrategyRuntimeState: mocks.resolveStrategyRuntimeState,
    syncStrategyEntryChanged: mocks.syncStrategyEntryChanged,
    upsertSyncStrategyEntry: mocks.upsertSyncStrategyEntry,
}))

function createStrategy(
    id: string,
    overrides: Partial<StoredStrategy> = {}
): StoredStrategy {
    return {
        _id: id as StoredStrategy["_id"],
        _creationTime: 0,
        app: "polymarket",
        name: `Strategy ${id}`,
        enabled: true,
        schedule: "0 * * * *",
        policy: {
            model: "openai/gpt-5.4",
            dryRun: true,
        },
        context: "baseline context",
        updatedAt: 1,
        ...overrides,
    }
}

function createEntry(strategy: StoredStrategy, overrides?: {
    policy?: Record<string, unknown>
    secrets?: Record<string, string | null>
}): SyncStrategyEntry {
    return {
        strategy,
        policy: overrides?.policy ?? strategy.policy,
        secrets: overrides?.secrets ?? {
            OPENROUTER_API_KEY: "old-key",
            POLYMARKET_API_KEY: "old-poly-key",
        },
    }
}

describe("reconcileStrategies", () => {
    beforeEach(() => {
        mocks.backend.getStrategyConfigs.mockReset()
        mocks.healthState.strategyCount = 0
        mocks.logger.error.mockReset()
        mocks.logger.info.mockReset()
        mocks.logger.warn.mockReset()
        mocks.registerStrategyWithScheduler.mockReset()
        mocks.resolveAllSecrets.mockReset()
        mocks.resolveStrategyRuntimeState.mockReset()
        mocks.syncStrategyEntryChanged.mockReset()
        mocks.upsertSyncStrategyEntry.mockClear()

        for (const key of Object.keys(mocks.syncStrategies)) {
            delete mocks.syncStrategies[key]
        }
    })

    it("re-registers already-registered strategies when the schedule changes", async () => {
        const { reconcileStrategies } = await import("./sync.ts")
        const currentStrategy = createStrategy("strategy-1", {
            schedule: "0 * * * *",
            updatedAt: 1,
        })
        const nextStrategy = createStrategy("strategy-1", {
            schedule: "*/5 * * * *",
            updatedAt: 2,
        })
        mocks.syncStrategies.polymarket = [createEntry(currentStrategy)]
        mocks.backend.getStrategyConfigs.mockImplementation(async (app: string) =>
            app === "polymarket" ? [nextStrategy] : []
        )
        mocks.resolveStrategyRuntimeState.mockResolvedValue(createEntry(nextStrategy))
        mocks.syncStrategyEntryChanged.mockReturnValue(true)

        const scheduler = {
            getRegisteredStrategies: () => ["strategy-1"],
            unregister: vi.fn(),
        }

        await reconcileStrategies(scheduler as never)

        expect(mocks.resolveAllSecrets).toHaveBeenCalledOnce()
        expect(mocks.registerStrategyWithScheduler).toHaveBeenCalledWith(
            scheduler,
            "polymarket",
            nextStrategy
        )
        expect(mocks.syncStrategies.polymarket?.[0]?.strategy.schedule).toBe("*/5 * * * *")
    })

    it("refreshes runtime policy and secrets in memory without re-registering when the cron is unchanged", async () => {
        const { reconcileStrategies } = await import("./sync.ts")
        const currentStrategy = createStrategy("strategy-1", {
            context: "old context",
            updatedAt: 1,
        })
        const nextStrategy = createStrategy("strategy-1", {
            context: "new context",
            updatedAt: 2,
        })
        const nextEntry = createEntry(nextStrategy, {
            policy: {
                model: "openai/gpt-5.4",
                dryRun: false,
                maxBet: 25,
            },
            secrets: {
                OPENROUTER_API_KEY: "new-openrouter-key",
                POLYMARKET_API_KEY: "new-poly-key",
            },
        })
        mocks.syncStrategies.polymarket = [createEntry(currentStrategy)]
        mocks.backend.getStrategyConfigs.mockImplementation(async (app: string) =>
            app === "polymarket" ? [nextStrategy] : []
        )
        mocks.resolveStrategyRuntimeState.mockResolvedValue(nextEntry)
        mocks.syncStrategyEntryChanged.mockReturnValue(true)

        const scheduler = {
            getRegisteredStrategies: () => ["strategy-1"],
            unregister: vi.fn(),
        }

        await reconcileStrategies(scheduler as never)

        expect(mocks.registerStrategyWithScheduler).not.toHaveBeenCalled()
        expect(mocks.syncStrategies.polymarket?.[0]).toEqual(nextEntry)
    })
})

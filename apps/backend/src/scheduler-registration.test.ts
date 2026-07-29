import { beforeEach, describe, expect, it, vi } from "vitest"
import type { StoredAccount, StoredStrategy } from "@valiq-trading/convex"

const mocks = vi.hoisted(() => {
    const backend = {
        getAccountByAppAndId: vi.fn(),
        resolveSecrets: vi.fn(),
    }
    const plugin = {
        resolveSecretKeys: vi.fn(),
        resolveAdditionalSecretKeys: vi.fn(),
    }

    return {
        backend,
        plugin,
        logger: {
            info: vi.fn(),
            warn: vi.fn(),
        },
        syncStrategies: {},
    }
})

vi.mock("./state", () => ({
    backend: mocks.backend,
    logger: mocks.logger,
    plugins: {
        mt5: mocks.plugin,
    },
    resolvedSecrets: {
        GLOBAL_SECRET: "global-secret",
    },
    syncStrategies: mocks.syncStrategies,
}))

vi.mock("@valiq-trading/core", () => ({
    buildAccountSecretKeyMap: (
        account: StoredAccount,
        keys: string[]
    ) => new Map(keys.map((key) => [key, `${account.credentialEnvPrefix}_${key}`])),
    resolveAccountScopedSecretKeys: (
        _app: string,
        keys: string[]
    ) => keys.filter((key) => key.startsWith("ACCOUNT_")),
    validatePolicy: (
        _app: string,
        policy: Record<string, unknown>
    ) => policy,
}))

vi.mock("./scheduler-runner", () => ({
    runStrategy: vi.fn(),
}))

import {
    invalidateStrategyRuntimeCacheForAccount,
    resolveStrategyRuntimeState,
} from "./scheduler-registration"

describe("strategy runtime state cache", () => {
    beforeEach(() => {
        vi.useRealTimers()
        invalidateStrategyRuntimeCacheForAccount("mt5", "account-mt5")
        mocks.backend.getAccountByAppAndId.mockReset()
        mocks.backend.resolveSecrets.mockReset()
        mocks.plugin.resolveSecretKeys.mockReset()
        mocks.plugin.resolveAdditionalSecretKeys.mockReset()
        mocks.backend.getAccountByAppAndId.mockResolvedValue(createAccount())
        mocks.backend.resolveSecrets.mockImplementation(async (keys: string[]) =>
            Object.fromEntries(keys.map((key) => [key, `${key}:resolved`]))
        )
        mocks.plugin.resolveSecretKeys.mockReturnValue(["ACCOUNT_BASE_SECRET"])
        mocks.plugin.resolveAdditionalSecretKeys.mockReturnValue([
            "ACCOUNT_EXTRA_SECRET",
            "SHARED_EXTRA_SECRET",
        ])
    })

    it("reuses account config and strategy secrets within the TTL for an unchanged strategy version", async () => {
        vi.useFakeTimers()
        vi.setSystemTime(1_000)
        const strategy = createStrategy("strategy-cache-hit", 100)

        const first = await resolveStrategyRuntimeState("mt5", strategy)
        const second = await resolveStrategyRuntimeState("mt5", strategy)

        expect(second).toBe(first)
        expect(mocks.backend.getAccountByAppAndId).toHaveBeenCalledTimes(1)
        expect(mocks.backend.resolveSecrets).toHaveBeenCalledTimes(2)

        vi.setSystemTime(60 * 60 * 1000 + 1_001)
        await resolveStrategyRuntimeState("mt5", strategy)

        expect(mocks.backend.getAccountByAppAndId).toHaveBeenCalledTimes(2)
        expect(mocks.backend.resolveSecrets).toHaveBeenCalledTimes(4)
    })

    it("invalidates when the strategy version changes or the account cache is dropped", async () => {
        vi.useFakeTimers()
        vi.setSystemTime(2_000)
        const strategy = createStrategy("strategy-cache-version", 100)

        await resolveStrategyRuntimeState("mt5", strategy)
        await resolveStrategyRuntimeState("mt5", {
            ...strategy,
            updatedAt: 101,
        })

        expect(mocks.backend.getAccountByAppAndId).toHaveBeenCalledTimes(2)

        expect(invalidateStrategyRuntimeCacheForAccount("mt5", strategy.accountId)).toBe(1)
        await resolveStrategyRuntimeState("mt5", {
            ...strategy,
            updatedAt: 101,
        })

        expect(mocks.backend.getAccountByAppAndId).toHaveBeenCalledTimes(3)
        expect(mocks.backend.resolveSecrets).toHaveBeenCalledTimes(6)
    })
})

function createStrategy(id: string, updatedAt: number): StoredStrategy {
    return {
        _id: id as StoredStrategy["_id"],
        _creationTime: 1,
        app: "mt5",
        accountId: "account-mt5",
        name: "MT5 cache test",
        enabled: true,
        schedule: "*/5 * * * *",
        policy: { dryRun: false },
        context: "",
        createdAt: 1,
        updatedAt,
    }
}

function createAccount(): StoredAccount {
    return {
        _id: "account-doc-mt5" as StoredAccount["_id"],
        _creationTime: 1,
        app: "mt5",
        accountId: "account-mt5",
        label: "MT5",
        credentialEnvPrefix: "MT5_ACCOUNT",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
    }
}

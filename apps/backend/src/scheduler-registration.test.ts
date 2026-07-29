import { beforeEach, describe, expect, it, vi } from "vitest"
import type { StoredAccount, StoredStrategy } from "@valiq-trading/convex"

const mocks = vi.hoisted(() => {
    const backend = {
        getAccounts: vi.fn(),
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
    compareCodeUnits: (left: string, right: string) => {
        if (left < right) {
            return -1
        }
        if (left > right) {
            return 1
        }

        return 0
    },
    resolveAccountScopedSecretKeys: (
        _app: string,
        keys: string[]
    ) => keys.filter((key) => key.startsWith("ACCOUNT_")),
    sha256Hex: (value: string) => `hash:${value}`,
    stableJsonKey: (value: unknown) => JSON.stringify(value),
    validatePolicy: (
        _app: string,
        policy: Record<string, unknown>
    ) => policy,
}))

vi.mock("./scheduler-runner", () => ({
    runStrategy: vi.fn(),
}))

import {
    clearStrategyRuntimeResolutionCaches,
    createStrategyRuntimeAccountSnapshot,
    invalidateStrategySecretCacheForAccount,
    resolveStrategyRuntimeState,
} from "./scheduler-registration"

describe("strategy runtime state resolution", () => {
    beforeEach(() => {
        vi.useRealTimers()
        clearStrategyRuntimeResolutionCaches()
        mocks.backend.getAccounts.mockReset()
        mocks.backend.resolveSecrets.mockReset()
        mocks.plugin.resolveSecretKeys.mockReset()
        mocks.plugin.resolveAdditionalSecretKeys.mockReset()
        mocks.backend.getAccounts.mockResolvedValue([createAccount()])
        mocks.backend.resolveSecrets.mockImplementation(async (keys: string[]) =>
            Object.fromEntries(keys.map((key) => [key, `${key}:resolved`]))
        )
        mocks.plugin.resolveSecretKeys.mockReturnValue(["ACCOUNT_BASE_SECRET"])
        mocks.plugin.resolveAdditionalSecretKeys.mockReturnValue([
            "ACCOUNT_EXTRA_SECRET",
            "SHARED_EXTRA_SECRET",
        ])
    })

    it("reads accounts fresh but caches resolved strategy secrets within the TTL", async () => {
        vi.useFakeTimers()
        vi.setSystemTime(1_000)
        const strategy = createStrategy("strategy-resolve-repeat", 100)

        mocks.backend.resolveSecrets.mockImplementation(async (keys: string[]) =>
            Object.fromEntries(keys.map((key) => [key, `${key}:initial`]))
        )

        const first = await resolveStrategyRuntimeState("mt5", strategy)
        const second = await resolveStrategyRuntimeState("mt5", strategy)

        expect(second).not.toBe(first)
        expect(first.secrets).toMatchObject({
            GLOBAL_SECRET: "global-secret",
            ACCOUNT_BASE_SECRET: "MT5_ACCOUNT_ACCOUNT_BASE_SECRET:initial",
            ACCOUNT_EXTRA_SECRET: "MT5_ACCOUNT_ACCOUNT_EXTRA_SECRET:initial",
            SHARED_EXTRA_SECRET: "SHARED_EXTRA_SECRET:initial",
        })
        expect(second.secrets).toMatchObject(first.secrets)

        expect(mocks.backend.getAccounts).toHaveBeenCalledTimes(2)
        expect(mocks.backend.getAccounts).toHaveBeenNthCalledWith(1, "mt5")
        expect(mocks.backend.getAccounts).toHaveBeenNthCalledWith(2, "mt5")
        expect(mocks.backend.resolveSecrets).toHaveBeenCalledTimes(1)
        expect(mocks.backend.resolveSecrets).toHaveBeenNthCalledWith(1, [
            "MT5_ACCOUNT_ACCOUNT_BASE_SECRET",
            "MT5_ACCOUNT_ACCOUNT_EXTRA_SECRET",
            "SHARED_EXTRA_SECRET",
        ])

        mocks.backend.resolveSecrets.mockImplementation(async (keys: string[]) =>
            Object.fromEntries(keys.map((key) => [key, `${key}:rotated`]))
        )
        vi.setSystemTime(15 * 60 * 1000 + 1_001)

        const third = await resolveStrategyRuntimeState("mt5", strategy)

        expect(third.secrets).toMatchObject({
            ACCOUNT_BASE_SECRET: "MT5_ACCOUNT_ACCOUNT_BASE_SECRET:rotated",
            ACCOUNT_EXTRA_SECRET: "MT5_ACCOUNT_ACCOUNT_EXTRA_SECRET:rotated",
            SHARED_EXTRA_SECRET: "SHARED_EXTRA_SECRET:rotated",
        })
        expect(mocks.backend.getAccounts).toHaveBeenCalledTimes(3)
        expect(mocks.backend.resolveSecrets).toHaveBeenCalledTimes(2)
    })

    it("a run-trigger resolution bypasses the cache and sees a rotated secret immediately", async () => {
        const strategy = createStrategy("strategy-fresh-run", 100)

        mocks.backend.resolveSecrets.mockImplementation(async (keys: string[]) =>
            Object.fromEntries(keys.map((key) => [key, `${key}:initial`]))
        )
        await resolveStrategyRuntimeState("mt5", strategy)

        mocks.backend.resolveSecrets.mockImplementation(async (keys: string[]) =>
            Object.fromEntries(keys.map((key) => [key, `${key}:rotated`]))
        )

        const stale = await resolveStrategyRuntimeState("mt5", strategy)
        expect(stale.secrets).toMatchObject({
            ACCOUNT_BASE_SECRET: "MT5_ACCOUNT_ACCOUNT_BASE_SECRET:initial",
        })
        expect(mocks.backend.resolveSecrets).toHaveBeenCalledTimes(1)

        const fresh = await resolveStrategyRuntimeState("mt5", strategy, undefined, {
            freshSecrets: true,
        })
        expect(fresh.secrets).toMatchObject({
            ACCOUNT_BASE_SECRET: "MT5_ACCOUNT_ACCOUNT_BASE_SECRET:rotated",
        })
        expect(mocks.backend.resolveSecrets).toHaveBeenCalledTimes(2)

        const afterFresh = await resolveStrategyRuntimeState("mt5", strategy)
        expect(afterFresh.secrets).toMatchObject({
            ACCOUNT_BASE_SECRET: "MT5_ACCOUNT_ACCOUNT_BASE_SECRET:rotated",
        })
        expect(mocks.backend.resolveSecrets).toHaveBeenCalledTimes(2)
    })

    it("fails closed when the account is disabled after a previous resolution", async () => {
        const strategy = createStrategy("strategy-disabled-account", 100)
        mocks.backend.getAccounts
            .mockResolvedValueOnce([createAccount()])
            .mockResolvedValueOnce([{
                ...createAccount(),
                status: "disabled",
            }])

        await resolveStrategyRuntimeState("mt5", strategy)

        await expect(resolveStrategyRuntimeState("mt5", strategy)).rejects.toThrow(
            "references inactive account mt5:account-mt5"
        )
        expect(mocks.backend.getAccounts).toHaveBeenCalledTimes(2)
        expect(mocks.backend.resolveSecrets).toHaveBeenCalledTimes(1)
    })

    it("drops cached strategy secrets when account validation fails", async () => {
        const strategy = createStrategy("strategy-validation-drop", 100)

        await resolveStrategyRuntimeState("mt5", strategy)
        expect(invalidateStrategySecretCacheForAccount("mt5", "account-mt5")).toBe(1)
        await resolveStrategyRuntimeState("mt5", strategy)

        expect(mocks.backend.getAccounts).toHaveBeenCalledTimes(2)
        expect(mocks.backend.resolveSecrets).toHaveBeenCalledTimes(2)
    })

    it("resolves a fresh account batch once for multiple strategies", async () => {
        const firstStrategy = createStrategy("strategy-batch-first", 100, "account-mt5")
        const secondStrategy = createStrategy("strategy-batch-second", 100, "account-other")

        mocks.backend.getAccounts.mockResolvedValue([
            createAccount("account-mt5", "MT5_ACCOUNT"),
            createAccount("account-other", "MT5_OTHER"),
        ])

        const accountSnapshot = await createStrategyRuntimeAccountSnapshot("mt5")
        const entries = [
            await resolveStrategyRuntimeState("mt5", firstStrategy, accountSnapshot),
            await resolveStrategyRuntimeState("mt5", secondStrategy, accountSnapshot),
        ]

        expect(entries.map((entry) => entry.account.accountId)).toEqual([
            "account-mt5",
            "account-other",
        ])
        expect(mocks.backend.getAccounts).toHaveBeenCalledTimes(1)
        expect(mocks.backend.resolveSecrets).toHaveBeenCalledTimes(2)
    })
})

function createStrategy(
    id: string,
    updatedAt: number,
    accountId = "account-mt5"
): StoredStrategy {
    return {
        _id: id as StoredStrategy["_id"],
        _creationTime: 1,
        app: "mt5",
        accountId,
        name: "MT5 cache test",
        enabled: true,
        schedule: "*/5 * * * *",
        policy: { dryRun: false },
        context: "",
        createdAt: 1,
        updatedAt,
    }
}

function createAccount(
    accountId = "account-mt5",
    credentialEnvPrefix = "MT5_ACCOUNT"
): StoredAccount {
    return {
        _id: `account-doc-${accountId}` as StoredAccount["_id"],
        _creationTime: 1,
        app: "mt5",
        accountId,
        label: "MT5",
        credentialEnvPrefix,
        status: "active",
        createdAt: 1,
        updatedAt: 1,
    }
}

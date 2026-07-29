import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
    backend: {
        resolveSecrets: vi.fn(),
    },
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
    plugin: {
        resolveSecretKeys: vi.fn(),
    },
    setResolvedSecrets: vi.fn(),
}))

vi.mock("../state", () => ({
    backend: mocks.backend,
    healthState: {
        venues: {},
    },
    logger: mocks.logger,
    plugins: {
        mt5: mocks.plugin,
    },
    setResolvedSecrets: mocks.setResolvedSecrets,
    syncStrategies: {},
}))

vi.mock("../scheduler-provider-gates", () => ({
    STRATEGY_LLM_PROVIDER_SECRET_KEYS: ["OPENROUTER_API_KEY"],
}))

vi.mock("../health-write", () => ({
    writeHeartbeatSnapshot: vi.fn(),
}))

import { resolveAllSecrets } from "./init"

describe("resolveAllSecrets", () => {
    beforeEach(() => {
        mocks.backend.resolveSecrets.mockReset()
        mocks.logger.info.mockReset()
        mocks.logger.warn.mockReset()
        mocks.plugin.resolveSecretKeys.mockReset()
        mocks.setResolvedSecrets.mockReset()
        mocks.plugin.resolveSecretKeys.mockReturnValue(["MT5_API_KEY"])
        mocks.backend.resolveSecrets.mockImplementation(async (keys: string[]) =>
            Object.fromEntries(keys.map((key) => [key, `${key}:resolved`]))
        )
    })

    it("resolves Convex environment secrets on every call", async () => {
        await resolveAllSecrets()
        await resolveAllSecrets()

        expect(mocks.backend.resolveSecrets).toHaveBeenCalledTimes(2)
        expect(mocks.backend.resolveSecrets).toHaveBeenNthCalledWith(1, [
            "OPENROUTER_API_KEY",
            "MT5_API_KEY",
        ])
        expect(mocks.backend.resolveSecrets).toHaveBeenNthCalledWith(2, [
            "OPENROUTER_API_KEY",
            "MT5_API_KEY",
        ])
        expect(mocks.setResolvedSecrets).toHaveBeenCalledTimes(2)
    })
})

import { afterEach, describe, expect, it } from "vitest"
import { MT5_POLICY_DEFAULTS } from "@valiq-trading/core"
import { resolveCanonicalFiveSocketAccountExecutionSymbols } from "@valiq-trading/mt5"

const testEnv = {
    CONVEX_URL: "https://convex.test",
    BACKEND_SERVICE_TOKEN: "backend-token",
}
const testRuntime = globalThis as typeof globalThis & {
    Bun?: {
        env: Record<string, string | undefined>
    }
}

if (testRuntime.Bun) {
    Object.assign(testRuntime.Bun.env, testEnv)
} else {
    Object.defineProperty(testRuntime, "Bun", {
        value: {
            env: { ...testEnv },
        },
        configurable: true,
    })
}

const [{ syncStrategies }, { resolveMt5AccountExecutionPolicySources }] = await Promise.all([
    import("../state"),
    import("./mt5"),
])

describe("MT5 plugin account execution policy", () => {
    afterEach(() => {
        syncStrategies.mt5 = []
    })

    it("derives FiveSocket symbols from the requested account only", () => {
        syncStrategies.mt5 = [
            createMt5Entry("primary", true, ["XAUUSD", "USDJPY"]),
            createMt5Entry("secondary", true, ["GBPUSD"]),
        ]

        const executionSymbols = resolveCanonicalFiveSocketAccountExecutionSymbols(
            resolveMt5AccountExecutionPolicySources("secondary"),
            "1.0"
        )

        expect(executionSymbols).toEqual([
            { symbol: "GBPUSD", maxVolume: "1.0" },
        ])
    })
})

function createMt5Entry(
    accountId: string,
    enabled: boolean,
    symbols: string[]
) {
    const marketRegionsByInstrument = Object.fromEntries(
        symbols.map((symbol) => [symbol, ["EU"]])
    )

    return {
        strategy: {
            _id: `${accountId}-strategy`,
            app: "mt5",
            accountId,
            name: `${accountId} strategy`,
            enabled,
            schedule: "* * * * *",
            policy: {},
            context: "",
        },
        account: {
            _id: `${accountId}-account`,
            app: "mt5",
            accountId,
            label: accountId,
            credentialEnvPrefix: `MT5_${accountId.toUpperCase()}`,
            status: "active",
        },
        policy: {
            ...MT5_POLICY_DEFAULTS,
            marketRegionsByInstrument,
        },
        secrets: {},
    } as never
}

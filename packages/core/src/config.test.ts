import { describe, expect, it } from "vitest"
import {
    readConfiguredStrategySafetyPolicy,
    resolveRuntimeStrategySafetyPolicy,
} from "./config.ts"

describe("strategy safety policy resolution", () => {
    it("resolves configured drawdown percentages against positive account balance", () => {
        const configured = readConfiguredStrategySafetyPolicy({
            safety: {
                maxDrawdownDay: 3,
                maxDrawdownWeek: 10,
                cooldownMinutesAfterDayBreach: 720,
                cooldownMinutesAfterWeekBreach: 1440,
                strategyTimezone: "UTC",
            },
        })

        const runtime = resolveRuntimeStrategySafetyPolicy({
            policy: configured,
            accountBalance: 20_000,
        })

        expect(runtime.maxDrawdownDay).toBe(600)
        expect(runtime.maxDrawdownWeek).toBe(2000)

        expect(() => resolveRuntimeStrategySafetyPolicy({
            policy: configured,
            accountBalance: 0,
        })).toThrow("positive account balance")
    })

})

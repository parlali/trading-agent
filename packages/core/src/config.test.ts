import { describe, expect, it } from "vitest"
import {
    readConfiguredStrategySafetyPolicy,
    resolveRuntimeStrategySafetyPolicy,
} from "./config.ts"

describe("strategy safety policy resolution", () => {
    it("treats configured max drawdown values as percentages of account balance", () => {
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
    })

    it("fails closed when a configured drawdown percentage has no positive balance to resolve against", () => {
        const configured = readConfiguredStrategySafetyPolicy({
            safety: {
                maxDrawdownDay: 3,
            },
        })

        expect(() => resolveRuntimeStrategySafetyPolicy({
            policy: configured,
            accountBalance: 0,
        })).toThrow("positive account balance")
    })

    it("preserves cooldown settings when no drawdown percentage is configured", () => {
        const configured = readConfiguredStrategySafetyPolicy({
            safety: {
                cooldownMinutesAfterDayBreach: 60,
                cooldownMinutesAfterWeekBreach: 120,
                strategyTimezone: "America/New_York",
            },
        })

        const runtime = resolveRuntimeStrategySafetyPolicy({
            policy: configured,
        })

        expect(runtime.maxDrawdownDay).toBeUndefined()
        expect(runtime.maxDrawdownWeek).toBeUndefined()
        expect(runtime.cooldownMinutesAfterDayBreach).toBe(60)
        expect(runtime.cooldownMinutesAfterWeekBreach).toBe(120)
        expect(runtime.strategyTimezone).toBe("America/New_York")
    })
})

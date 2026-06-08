import { describe, expect, it } from "vitest"
import {
    migrateLegacyStrategyLlmPolicy,
    readConfiguredStrategySafetyPolicy,
    resolveStrategyLlmConfig,
    resolveRuntimeStrategySafetyPolicy,
    validatePolicy,
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

describe("strategy LLM policy", () => {
    it("resolves explicit OpenRouter and Codex provider configs", () => {
        expect(resolveStrategyLlmConfig({
            llm: {
                provider: "openrouter",
                model: "openai/gpt-5.4",
                reasoning: {
                    effort: "high",
                    exclude: false,
                },
            },
        })).toMatchObject({
            provider: "openrouter",
            model: "openai/gpt-5.4",
            reasoning: {
                effort: "high",
                exclude: false,
            },
        })

        expect(resolveStrategyLlmConfig({
            llm: {
                provider: "codex",
                model: "gpt-5.4",
                effort: "medium",
                summary: "concise",
                authMode: "chatgpt",
            },
        })).toMatchObject({
            provider: "codex",
            model: "gpt-5.4",
            authMode: "chatgpt",
        })
    })

    it("migrates legacy top-level model fields to canonical OpenRouter policy", () => {
        const migrated = migrateLegacyStrategyLlmPolicy({
            dryRun: true,
            model: "openai/gpt-5.4",
            reasoning: {
                effort: "low",
            },
            maxLossPerPlay: 500,
        })

        expect(migrated).toMatchObject({
            dryRun: true,
            maxLossPerPlay: 500,
            llm: {
                provider: "openrouter",
                model: "openai/gpt-5.4",
                reasoning: {
                    effort: "low",
                    exclude: true,
                },
            },
        })
        expect("model" in migrated).toBe(false)
        expect("reasoning" in migrated).toBe(false)
    })

    it("rejects ambiguous mixed legacy and canonical policy", () => {
        expect(() => validatePolicy("alpaca-options", {
            dryRun: true,
            model: "openai/gpt-5.4",
            llm: {
                provider: "openrouter",
                model: "openai/gpt-5.4",
            },
            maxLossPerPlay: 500,
        })).toThrow("mixed legacy and canonical")
    })
})

import { describe, expect, it } from "vitest"
import { assertStrategyLlmProviderCanRun } from "./scheduler-provider-gates"

describe("scheduler provider gates", () => {
    it("fails closed for OpenRouter strategies without OPENROUTER_API_KEY", () => {
        expect(() => assertStrategyLlmProviderCanRun(
            {
                provider: "openrouter",
                model: "openrouter/test",
            },
            { dryRun: true },
            createSecrets(),
            { codexProviderEnabled: false, env: {} }
        )).toThrow("OPENROUTER_API_KEY is not set")
    })

    it("allows OpenRouter strategies when OPENROUTER_API_KEY is present", () => {
        expect(() => assertStrategyLlmProviderCanRun(
            {
                provider: "openrouter",
                model: "openrouter/test",
            },
            { dryRun: true },
            createSecrets({
                OPENROUTER_API_KEY: "openrouter-key",
            }),
            { codexProviderEnabled: false, env: {} }
        )).not.toThrow()
    })

    it("allows Codex strategies without OPENROUTER_API_KEY when Codex is enabled", () => {
        expect(() => assertStrategyLlmProviderCanRun(
            {
                provider: "codex",
                model: "codex-test",
                authMode: "chatgpt",
            },
            { dryRun: true },
            createSecrets(),
            { codexProviderEnabled: true, env: {} }
        )).not.toThrow()
    })

    it("fails closed for Codex access-token auth without a token", () => {
        expect(() => assertStrategyLlmProviderCanRun(
            {
                provider: "codex",
                model: "codex-test",
                authMode: "access-token",
            },
            { dryRun: true },
            createSecrets(),
            { codexProviderEnabled: true, env: {} }
        )).toThrow("CODEX_ACCESS_TOKEN is required")
    })

    it("rejects Codex live strategies while the dry-run gate is active", () => {
        expect(() => assertStrategyLlmProviderCanRun(
            {
                provider: "codex",
                model: "codex-test",
                authMode: "chatgpt",
            },
            { dryRun: false },
            createSecrets(),
            { codexProviderEnabled: true, env: {} }
        )).toThrow("Codex provider is dry-run only")
    })

    it("fails closed when the Codex provider feature flag is disabled", () => {
        expect(() => assertStrategyLlmProviderCanRun(
            {
                provider: "codex",
                model: "codex-test",
                authMode: "chatgpt",
            },
            { dryRun: true },
            createSecrets(),
            { codexProviderEnabled: false, env: {} }
        )).toThrow("ENABLE_CODEX_PROVIDER must be true")
    })
})

function createSecrets(overrides: Record<string, string | null> = {}): Record<string, string | null> {
    return {
        OPENROUTER_API_KEY: null,
        CODEX_ACCESS_TOKEN: null,
        OPENAI_API_KEY: null,
        ...overrides,
    }
}

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
            { env: {} }
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
            { env: {} }
        )).not.toThrow()
    })

    it("allows Codex ChatGPT strategies without OPENROUTER_API_KEY when login is active", () => {
        expect(() => assertStrategyLlmProviderCanRun(
            {
                provider: "codex",
                model: "codex-test",
                authMode: "chatgpt",
            },
            { dryRun: true },
            createSecrets(),
            {
                env: {},
                codexChatGptAuthStatus: createCodexAuthStatus(true),
            }
        )).not.toThrow()
    })

    it("fails closed for Codex ChatGPT auth without an active login", () => {
        expect(() => assertStrategyLlmProviderCanRun(
            {
                provider: "codex",
                model: "codex-test",
                authMode: "chatgpt",
            },
            { dryRun: true },
            createSecrets(),
            {
                env: {},
                codexChatGptAuthStatus: createCodexAuthStatus(false, "Codex ChatGPT login is missing"),
            }
        )).toThrow("Codex ChatGPT login is required")
    })

    it("fails closed for Codex auth modes that are not ChatGPT login", () => {
        expect(() => assertStrategyLlmProviderCanRun(
            {
                provider: "codex",
                model: "codex-test",
                authMode: "access-token",
            },
            { dryRun: true },
            createSecrets(),
            { env: {} }
        )).toThrow("Codex provider requires ChatGPT login auth")
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
            { env: {} }
        )).toThrow("Codex provider is dry-run only")
    })
})

function createSecrets(overrides: Record<string, string | null> = {}): Record<string, string | null> {
    return {
        OPENROUTER_API_KEY: null,
        ...overrides,
    }
}

function createCodexAuthStatus(ready: boolean, message = "Codex ChatGPT login is active") {
    return {
        ready,
        status: ready ? "ready" as const : "missing" as const,
        codexHome: "/tmp/codex",
        authFilePath: "/tmp/codex/auth.json",
        accountId: ready ? "account-1" : null,
        lastRefresh: ready ? "2026-06-09T00:00:00.000Z" : null,
        message,
    }
}

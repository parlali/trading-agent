import { describe, expect, it } from "vitest"
import type { StoredStrategy } from "@valiq-trading/convex"
import { resolveStoredCodexPreflightConfig } from "./codex-preflight-config"

describe("resolveStoredCodexPreflightConfig", () => {
    it("accepts exactly dry-run Codex strategy preflight with enabled provider gate", () => {
        const result = resolveStoredCodexPreflightConfig({
            strategy: createStrategy(),
            strategySecrets: createSecrets(),
            dryRunOnly: true,
            codexProviderEnabled: true,
            env: {},
        })

        expect(result.llm.provider).toBe("codex")
        expect(result.llm.authMode).toBe("chatgpt")
        expect(result.source).toBe("strategy Codex Dry Run (strategy-1)")
    })

    it("requires the explicit dry-run-only flag for stored strategy preflight", () => {
        expect(() => resolveStoredCodexPreflightConfig({
            strategy: createStrategy(),
            strategySecrets: createSecrets(),
            dryRunOnly: false,
            codexProviderEnabled: true,
            env: {},
        })).toThrow("--dry-run-only is required when --strategy is provided")
    })

    it("rejects live strategies before resolving provider credentials", () => {
        expect(() => resolveStoredCodexPreflightConfig({
            strategy: createStrategy({
                policy: {
                    dryRun: false,
                    llm: {
                        provider: "codex",
                        model: "gpt-5.4",
                        authMode: "chatgpt",
                    },
                },
            }),
            strategySecrets: createSecrets(),
            dryRunOnly: true,
            codexProviderEnabled: true,
            env: {},
        })).toThrow("Codex preflight requires a dry-run strategy")
    })

    it("rejects non-Codex stored strategies", () => {
        expect(() => resolveStoredCodexPreflightConfig({
            strategy: createStrategy({
                policy: {
                    dryRun: true,
                    llm: {
                        provider: "openrouter",
                        model: "openrouter/test",
                    },
                },
            }),
            strategySecrets: createSecrets({
                OPENROUTER_API_KEY: "openrouter-key",
            }),
            dryRunOnly: true,
            codexProviderEnabled: true,
            env: {},
        })).toThrow("Codex preflight requires a Codex strategy, got openrouter")
    })

    it("fails closed when the Codex provider gate is disabled", () => {
        expect(() => resolveStoredCodexPreflightConfig({
            strategy: createStrategy(),
            strategySecrets: createSecrets(),
            dryRunOnly: true,
            codexProviderEnabled: false,
            env: {},
        })).toThrow("ENABLE_CODEX_PROVIDER must be true")
    })

    it("fails closed for access-token auth without a credential", () => {
        expect(() => resolveStoredCodexPreflightConfig({
            strategy: createStrategy({
                policy: {
                    dryRun: true,
                    llm: {
                        provider: "codex",
                        model: "gpt-5.4",
                        authMode: "access-token",
                    },
                },
            }),
            strategySecrets: createSecrets(),
            dryRunOnly: true,
            codexProviderEnabled: true,
            env: {},
        })).toThrow("CODEX_ACCESS_TOKEN is required")
    })

    it("fails closed for api-key auth without a credential", () => {
        expect(() => resolveStoredCodexPreflightConfig({
            strategy: createStrategy({
                policy: {
                    dryRun: true,
                    llm: {
                        provider: "codex",
                        model: "gpt-5.4",
                        authMode: "api-key",
                    },
                },
            }),
            strategySecrets: createSecrets(),
            dryRunOnly: true,
            codexProviderEnabled: true,
            env: {},
        })).toThrow("OPENAI_API_KEY is required")
    })

    it("uses bounded explicit environment credentials for stored api-key preflight", () => {
        const result = resolveStoredCodexPreflightConfig({
            strategy: createStrategy({
                policy: {
                    dryRun: true,
                    llm: {
                        provider: "codex",
                        model: "gpt-5.4",
                        authMode: "api-key",
                    },
                },
            }),
            strategySecrets: createSecrets(),
            dryRunOnly: true,
            codexProviderEnabled: true,
            env: {
                OPENAI_API_KEY: "env-api-key",
            },
        })

        expect(result.llm.authMode).toBe("api-key")
    })
})

function createStrategy(overrides: Partial<StoredStrategy> = {}): StoredStrategy {
    return {
        _id: "strategy-1" as StoredStrategy["_id"],
        _creationTime: 1,
        app: "polymarket",
        name: "Codex Dry Run",
        enabled: true,
        schedule: "0 * * * *",
        context: "context",
        policy: {
            dryRun: true,
            llm: {
                provider: "codex",
                model: "gpt-5.4",
                authMode: "chatgpt",
            },
        },
        ...overrides,
    }
}

function createSecrets(overrides: Record<string, string | null> = {}): Record<string, string | null> {
    return {
        OPENROUTER_API_KEY: null,
        CODEX_ACCESS_TOKEN: null,
        OPENAI_API_KEY: null,
        ...overrides,
    }
}

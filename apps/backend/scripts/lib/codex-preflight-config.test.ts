import { describe, expect, it } from "vitest"
import { fileURLToPath } from "node:url"
import type { StoredStrategy } from "@valiq-trading/convex"
import { resolveStoredCodexPreflightConfig } from "./codex-preflight-config"

describe("resolveStoredCodexPreflightConfig", () => {
    it("accepts exactly dry-run Codex strategy preflight with active ChatGPT login", () => {
        const result = resolveStoredCodexPreflightConfig({
            strategy: createStrategy(),
            strategySecrets: createSecrets(),
            dryRunOnly: true,
            env: createCodexAuthEnv(),
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
            env: createCodexAuthEnv(),
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
            env: createCodexAuthEnv(),
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
            env: createCodexAuthEnv(),
        })).toThrow("Codex preflight requires a Codex strategy, got openrouter")
    })

    it("fails closed when ChatGPT login is missing", () => {
        expect(() => resolveStoredCodexPreflightConfig({
            strategy: createStrategy(),
            strategySecrets: createSecrets(),
            dryRunOnly: true,
            env: createMissingCodexAuthEnv(),
        })).toThrow("Codex ChatGPT login is required")
    })

    it("fails closed for Codex auth modes that are not ChatGPT login", () => {
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
            env: {},
        })).toThrow("Codex provider requires ChatGPT login auth")
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

function createCodexAuthEnv(): Record<string, string | undefined> {
    return {
        CODEX_HOME: fileURLToPath(new URL("./fixtures/codex-home", import.meta.url)),
    }
}

function createMissingCodexAuthEnv(): Record<string, string | undefined> {
    return {
        CODEX_HOME: fileURLToPath(new URL("./fixtures/missing-codex-home", import.meta.url)),
    }
}

function createSecrets(overrides: Record<string, string | null> = {}): Record<string, string | null> {
    return {
        OPENROUTER_API_KEY: null,
        ...overrides,
    }
}

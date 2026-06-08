import type { StrategyLlmConfig } from "@valiq-trading/core"

export const STRATEGY_LLM_PROVIDER_SECRET_KEYS = [
    "OPENROUTER_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "OPENAI_API_KEY",
] as const

export function assertStrategyLlmProviderCanRun(
    llmConfig: StrategyLlmConfig,
    policy: Record<string, unknown>,
    strategySecrets: Record<string, string | null>,
    options: {
        codexProviderEnabled: boolean
        env?: Record<string, string | undefined>
    }
): void {
    if (llmConfig.provider === "openrouter") {
        if (!strategySecrets.OPENROUTER_API_KEY) {
            throw new Error("Cannot run strategy: OPENROUTER_API_KEY is not set in Convex environment variables")
        }
        return
    }

    assertCodexProviderCanRun(
        llmConfig,
        policy,
        strategySecrets,
        options.codexProviderEnabled,
        options.env ?? process.env
    )
}

function assertCodexProviderCanRun(
    llmConfig: Extract<StrategyLlmConfig, { provider: "codex" }>,
    policy: Record<string, unknown>,
    strategySecrets: Record<string, string | null>,
    isCodexProviderEnabled: boolean,
    env: Record<string, string | undefined>
): void {
    if (!isCodexProviderEnabled) {
        throw new Error("Cannot run strategy: ENABLE_CODEX_PROVIDER must be true for Codex provider runs")
    }

    if (policy.dryRun !== true) {
        throw new Error("Cannot run strategy: Codex provider is dry-run only until live-readiness gates pass")
    }

    if (llmConfig.authMode === "access-token" && !strategySecrets.CODEX_ACCESS_TOKEN && !env.CODEX_ACCESS_TOKEN) {
        throw new Error("Cannot run strategy: CODEX_ACCESS_TOKEN is required for Codex access-token auth")
    }

    if (llmConfig.authMode === "api-key" && !strategySecrets.OPENAI_API_KEY && !env.OPENAI_API_KEY) {
        throw new Error("Cannot run strategy: OPENAI_API_KEY is required for Codex api-key auth")
    }
}

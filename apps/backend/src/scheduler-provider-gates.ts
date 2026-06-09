import type { StrategyLlmConfig } from "@valiq-trading/core"
import { inspectCodexChatGptAuthStatusSync, type CodexChatGptAuthStatus } from "./codex-auth"

export const STRATEGY_LLM_PROVIDER_SECRET_KEYS = [
    "OPENROUTER_API_KEY",
] as const

export function assertStrategyLlmProviderCanRun(
    llmConfig: StrategyLlmConfig,
    _policy: Record<string, unknown>,
    strategySecrets: Record<string, string | null>,
    options: {
        env?: Record<string, string | undefined>
        codexChatGptAuthStatus?: CodexChatGptAuthStatus
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
        options.env ?? process.env,
        options.codexChatGptAuthStatus
    )
}

function assertCodexProviderCanRun(
    llmConfig: Extract<StrategyLlmConfig, { provider: "codex" }>,
    env: Record<string, string | undefined>,
    codexChatGptAuthStatus?: CodexChatGptAuthStatus
): void {
    if (llmConfig.authMode !== "chatgpt") {
        throw new Error("Cannot run strategy: Codex provider requires ChatGPT login auth")
    }

    const authStatus = codexChatGptAuthStatus ?? inspectCodexChatGptAuthStatusSync(env)
    if (!authStatus.ready) {
        throw new Error(`Cannot run strategy: Codex ChatGPT login is required. ${authStatus.message}`)
    }
}

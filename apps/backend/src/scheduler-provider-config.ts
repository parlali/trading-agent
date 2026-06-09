import type { AgentRuntimeModelProviderConfig } from "@valiq-trading/agent"
import type { StrategyLlmConfig } from "@valiq-trading/core"
import { readOpenRouterReasoningConfig } from "./scheduler-context"

export function createAgentProviderConfig(
    llmConfig: StrategyLlmConfig,
    strategySecrets: Record<string, string | null>,
    env: Record<string, string | undefined> = process.env
): AgentRuntimeModelProviderConfig {
    if (llmConfig.provider === "openrouter") {
        return {
            provider: "openrouter",
            apiKey: strategySecrets.OPENROUTER_API_KEY!,
            model: llmConfig.model,
            reasoning: readOpenRouterReasoningConfig(llmConfig),
            baseUrl: llmConfig.baseUrl,
        }
    }

    return {
        provider: "codex",
        model: llmConfig.model,
        effort: llmConfig.effort,
        summary: llmConfig.summary,
        serviceTier: llmConfig.serviceTier,
        authMode: llmConfig.authMode,
        codexBin: llmConfig.codexBin,
        codexAccessToken: strategySecrets.CODEX_ACCESS_TOKEN ?? env.CODEX_ACCESS_TOKEN,
        openAiApiKey: strategySecrets.OPENAI_API_KEY ?? env.OPENAI_API_KEY,
    }
}

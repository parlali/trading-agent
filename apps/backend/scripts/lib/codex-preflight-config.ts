import type { StoredStrategy } from "@valiq-trading/convex"
import {
    resolveStrategyLlmConfig,
    type CodexLlmProviderConfig,
} from "@valiq-trading/core"
import { assertStrategyLlmProviderCanRun } from "../../src/scheduler-provider-gates"

export function resolveStoredCodexPreflightConfig(args: {
    strategy: StoredStrategy
    strategySecrets: Record<string, string | null>
    dryRunOnly: boolean
    codexProviderEnabled: boolean
    env: Record<string, string | undefined>
}): {
    llm: CodexLlmProviderConfig
    source: string
    strategySecrets: Record<string, string | null>
} {
    if (!args.dryRunOnly) {
        throw new Error("--dry-run-only is required when --strategy is provided")
    }

    if (args.strategy.policy.dryRun !== true) {
        throw new Error(`Codex preflight requires a dry-run strategy: ${args.strategy.name}`)
    }

    const llm = resolveStrategyLlmConfig(args.strategy.policy)
    if (llm.provider !== "codex") {
        throw new Error(`Codex preflight requires a Codex strategy, got ${llm.provider}: ${args.strategy.name}`)
    }

    assertStrategyLlmProviderCanRun(llm, args.strategy.policy, args.strategySecrets, {
        codexProviderEnabled: args.codexProviderEnabled,
        env: args.env,
    })

    return {
        llm,
        source: `strategy ${args.strategy.name} (${args.strategy._id})`,
        strategySecrets: args.strategySecrets,
    }
}

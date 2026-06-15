import type { AgentMessageLogger, Logger, StrategyRunContext } from "@valiq-trading/core"
import type { LLMUsage } from "./llm-usage"
import { ConversationManager } from "./conversation"
import { buildSystemPrompt } from "./prompt-builder"
import { ToolExecutionEngine, type DegradedResearchOutcome, type OpportunityCoverageMetrics } from "./tool-execution-engine"
import type { ToolManifestEntry, ToolRegistry } from "./tool-registry"
import { OpenRouterAgentProvider, type OpenRouterAgentProviderConfig } from "./providers/openrouter/openrouter-agent-provider"
import { CodexAppServerProvider, type CodexAppServerProviderConfig } from "./providers/codex/codex-app-server-provider"
import type { AgentModelProvider, AgentProviderDiagnostics } from "./providers/types"
import { safeLogAgentMessage } from "./agent-transcript"

export type AgentRuntimeModelProviderConfig = OpenRouterAgentProviderConfig | CodexAppServerProviderConfig

export interface AgentRuntimeConfig {
    provider: AgentRuntimeModelProviderConfig
    tools: ToolRegistry
    logger: Logger
    maxIterations?: number
    maxConsecutiveErrors?: number
    runTimeoutMs?: number
    agentLogger?: AgentMessageLogger
    cleanup?: Array<() => Promise<void>>
    killSwitchChecker?: () => Promise<boolean>
    userMessage?: string
    abortSignal?: AbortSignal
}

export interface AgentRunResult {
    summary: string
    error?: string
    iterations: number
    usage: LLMUsage
    opportunityCoverage: OpportunityCoverageMetrics
    degradedResearch?: DegradedResearchOutcome
    providerDiagnostics: AgentProviderDiagnostics
    toolManifest: ToolManifestEntry[]
}

const DEFAULT_MAX_ITERATIONS = 25
const DEFAULT_MAX_CONSECUTIVE_ERRORS = 5
const DEFAULT_RUN_TIMEOUT_MS = 10 * 60 * 1000

export async function executeAgentRun(
    context: StrategyRunContext,
    config: AgentRuntimeConfig
): Promise<AgentRunResult> {
    const {
        provider: providerConfig,
        tools,
        logger,
        maxIterations = DEFAULT_MAX_ITERATIONS,
        maxConsecutiveErrors = DEFAULT_MAX_CONSECUTIVE_ERRORS,
        runTimeoutMs = DEFAULT_RUN_TIMEOUT_MS,
        agentLogger,
    } = config

    const conversation = new ConversationManager()
    const runStartedAt = Date.now()

    const systemPrompt = buildSystemPrompt(context, tools.getDescriptions())
    conversation.addSystemMessage(systemPrompt)
    const systemSequence = conversation.getSequence()

    const userMessage = config.userMessage ??
        "Your positions and account state are already in the system prompt. Begin with the research steps defined in your strategy context, then decide on actions."

    conversation.addUserMessage(userMessage)
    const userSequence = conversation.getSequence()

    await Promise.all([
        safeLogAgentMessage({
            agentLogger,
            logger,
            runId: context.runId,
            strategyId: context.strategyId,
            sequence: systemSequence,
            role: "system",
            content: systemPrompt,
        }),
        safeLogAgentMessage({
            agentLogger,
            logger,
            runId: context.runId,
            strategyId: context.strategyId,
            sequence: userSequence,
            role: "user",
            content: userMessage,
        }),
    ])

    const toolEngine = new ToolExecutionEngine({
        tools,
        context,
        logger,
        agentLogger,
        runStartedAt,
        runTimeoutMs,
        nextTranscriptSequence: () => conversation.reserveSequence(),
    })
    const provider = createAgentModelProvider(providerConfig)
    let aborted = false
    const abortProvider = () => {
        aborted = true
        provider.cancel()
    }
    if (config.abortSignal?.aborted) {
        abortProvider()
    } else {
        config.abortSignal?.addEventListener("abort", abortProvider, { once: true })
    }

    try {
        if (config.abortSignal?.aborted) {
            throw createAbortError("Agent run cancelled")
        }

        const providerResult = await provider.run({
            conversation,
            context,
            tools,
            toolEngine,
            logger,
            agentLogger,
            maxIterations,
            maxConsecutiveErrors,
            runStartedAt,
            runTimeoutMs,
            killSwitchChecker: config.killSwitchChecker,
        })
        const outcome = toolEngine.getOutcome()
        const decisionTaken = !providerResult.error && providerResult.summary.length > 0
        const error = aborted || config.abortSignal?.aborted
            ? providerResult.error ?? "Agent run cancelled"
            : providerResult.error

        return {
            summary: providerResult.summary,
            error,
            iterations: providerResult.iterations,
            usage: providerResult.usage,
            opportunityCoverage: outcome.opportunityCoverage,
            degradedResearch: outcome.degradedResearch(decisionTaken),
            providerDiagnostics: providerResult.diagnostics,
            toolManifest: tools.getManifest(),
        }
    } finally {
        config.abortSignal?.removeEventListener("abort", abortProvider)
        provider.cancel()
        if (config.cleanup && config.cleanup.length > 0) {
            for (const cleanup of config.cleanup) {
                try {
                    await cleanup()
                } catch (error) {
                    logger.error("Agent cleanup failed", {
                        error: error instanceof Error ? error.message : String(error),
                        runId: context.runId,
                    })
                }
            }
        }
    }
}

function createAbortError(message: string): Error {
    const error = new Error(message)
    error.name = "AbortError"
    return error
}

function createAgentModelProvider(config: AgentRuntimeModelProviderConfig): AgentModelProvider {
    if (config.provider === "openrouter") {
        return new OpenRouterAgentProvider(config)
    }

    if (config.provider === "codex") {
        return new CodexAppServerProvider(config)
    }

    throw new Error(`Unsupported model provider: ${(config as { provider?: string }).provider ?? "unknown"}`)
}

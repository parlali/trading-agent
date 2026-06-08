import type { AgentMessageLogger, Logger, StrategyRunContext } from "@valiq-trading/core"
import type { ConversationManager } from "../conversation"
import type { LLMUsage } from "../llm-client"
import type { ToolExecutionEngine } from "../tool-execution-engine"
import type { ToolRegistry } from "../tool-registry"

export type AgentModelProviderName = "openrouter" | "codex"

export interface AgentProviderDiagnostics {
    provider: AgentModelProviderName
    model: string
    authMode?: string
    billingMode?: string
    responseIds: string[]
    codexThreadId?: string
    codexTurnIds?: string[]
    rateLimitSnapshotBefore?: unknown
    rateLimitSnapshotAfter?: unknown
}

export interface AgentProviderRunResult {
    summary: string
    error?: string
    iterations: number
    usage: LLMUsage
    diagnostics: AgentProviderDiagnostics
}

export interface AgentProviderRunArgs {
    conversation: ConversationManager
    context: StrategyRunContext
    tools: ToolRegistry
    toolEngine: ToolExecutionEngine
    logger: Logger
    agentLogger?: AgentMessageLogger
    maxIterations: number
    maxConsecutiveErrors: number
    runStartedAt: number
    runTimeoutMs: number
    killSwitchChecker?: () => Promise<boolean>
}

export interface AgentModelProvider {
    provider: AgentModelProviderName
    run(args: AgentProviderRunArgs): Promise<AgentProviderRunResult>
    cancel(): void
}

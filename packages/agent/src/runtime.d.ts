import type { StrategyRunContext, Logger } from "@valiq-trading/core";
import type { ToolRegistry } from "./tool-registry";
import type { LLMClientConfig, LLMUsage } from "./llm-client";
export interface AgentRuntimeConfig {
    llm: LLMClientConfig;
    tools: ToolRegistry;
    logger: Logger;
    maxIterations?: number;
    maxConsecutiveErrors?: number;
    runTimeoutMs?: number;
    agentLogger?: AgentMessageLogger;
    cleanup?: Array<() => Promise<void>>;
    killSwitchChecker?: () => Promise<boolean>;
}
export interface AgentMessageLogger {
    log(runId: string, strategyId: string, sequence: number, role: string, content: string, toolName?: string, toolInput?: string, toolOutput?: string): Promise<void>;
}
export interface AgentRunResult {
    summary: string;
    error?: string;
    iterations: number;
    usage: LLMUsage;
}
export declare function executeAgentRun(context: StrategyRunContext, config: AgentRuntimeConfig): Promise<AgentRunResult>;
//# sourceMappingURL=runtime.d.ts.map
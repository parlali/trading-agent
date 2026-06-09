import { z } from "zod"
import {
    ToolRegistry,
    executeAgentRun,
    type CodexAppServerProviderConfig,
} from "@valiq-trading/agent"
import type { Id } from "@valiq-trading/convex"
import {
    createLogger,
    resolveStrategyLlmConfig,
    type AgentMessageLogger,
    type CodexLlmProviderConfig,
    type StrategyRunContext,
} from "@valiq-trading/core"
import { createAgentProviderConfig } from "../src/scheduler-provider-config"
import { STRATEGY_LLM_PROVIDER_SECRET_KEYS } from "../src/scheduler-provider-gates"
import {
    createClient,
    resolveArg,
    resolveFlag,
    resolvePositiveIntegerArg,
    runScript,
} from "./lib/strategy-cli"
import {
    assertCodexPreflightToolEvidence,
    type CodexPreflightToolEvidence,
} from "./lib/codex-preflight-evidence"
import { resolveStoredCodexPreflightConfig } from "./lib/codex-preflight-config"

declare const Bun: {
    env: Record<string, string | undefined>
    spawnSync(args: string[], options?: {
        stdout?: "pipe"
        stderr?: "pipe"
    }): {
        stdout: Uint8Array
        stderr: Uint8Array
        exitCode: number
    }
}

runScript(runCodexProviderPreflight)

async function runCodexProviderPreflight(): Promise<void> {
    const { llm, source, strategySecrets } = await resolvePreflightLlmConfig()

    const command = llm.codexBin ?? "codex"
    const version = readCodexVersion(command)
    console.log(`Codex preflight source: ${source}`)
    console.log(`Codex binary: ${command}`)
    console.log(`Codex version: ${version}`)

    const tools = new ToolRegistry()
    tools.register({
        name: "preflight_echo",
        description: "Return a preflight echo payload",
        parameters: z.object({
            value: z.string(),
        }),
        jsonSchema: {
            type: "object",
            properties: {
                value: {
                    type: "string",
                },
            },
            required: ["value"],
        },
        category: "research",
        handler: async (params) => {
            return {
                echoed: (params as { value: string }).value,
            }
        },
    })
    const toolEvidence: CodexPreflightToolEvidence[] = []
    const agentLogger: AgentMessageLogger = {
        async log(
            _runId,
            _strategyId,
            _sequence,
            role,
            _content,
            toolName,
            toolInput,
            toolOutput
        ) {
            if (role === "tool" && toolName) {
                toolEvidence.push({
                    toolName,
                    toolInput,
                    toolOutput,
                })
            }
        },
    }

    const providerConfig = createAgentProviderConfig(llm, strategySecrets, Bun.env)
    if (providerConfig.provider !== "codex") {
        throw new Error("Codex preflight resolved a non-Codex provider config")
    }
    const provider: CodexAppServerProviderConfig = {
        ...providerConfig,
        turnTimeoutMs: resolvePositiveIntegerArg("timeout-ms", 120_000, {
            min: 1000,
            max: 600_000,
        }),
    }
    const result = await executeAgentRun(createPreflightContext(llm), {
        provider,
        tools,
        logger: createLogger({ minLevel: "info" }),
        agentLogger,
        maxIterations: 1,
        runTimeoutMs: provider.turnTimeoutMs,
    })

    if (result.error) {
        throw new Error(`Codex preflight failed: ${result.error}`)
    }
    assertCodexPreflightToolEvidence(toolEvidence)

    console.log("Codex preflight passed")
    console.log(JSON.stringify({
        provider: result.providerDiagnostics.provider,
        model: result.providerDiagnostics.model,
        authMode: result.providerDiagnostics.authMode,
        billingMode: result.providerDiagnostics.billingMode,
        codexThreadId: result.providerDiagnostics.codexThreadId,
        codexTurnIds: result.providerDiagnostics.codexTurnIds,
        hasRateLimitBefore: result.providerDiagnostics.rateLimitSnapshotBefore !== undefined,
        hasRateLimitAfter: result.providerDiagnostics.rateLimitSnapshotAfter !== undefined,
    }, null, 2))
}

async function resolvePreflightLlmConfig(): Promise<{
    llm: CodexLlmProviderConfig
    source: string
    strategySecrets: Record<string, string | null>
}> {
    const strategyId = resolveArg("strategy")
    if (strategyId) {
        const client = createClient()
        const strategy = await client.getStrategyById(strategyId as Id<"strategies">)
        if (!strategy) {
            throw new Error(`Strategy not found: ${strategyId}`)
        }
        const strategySecrets = await client.resolveSecrets([...STRATEGY_LLM_PROVIDER_SECRET_KEYS])

        return resolveStoredCodexPreflightConfig({
            strategy,
            strategySecrets,
            dryRunOnly: resolveFlag("dry-run-only"),
            env: Bun.env,
        })
    }

    const model = resolveArg("model") ?? "gpt-5.4"
    const authMode = resolveAuthMode(resolveArg("auth-mode") ?? "chatgpt")
    const codexBin = resolveArg("codex-bin")
    const effort = resolveArg("effort") as CodexLlmProviderConfig["effort"] | undefined
    const summary = resolveArg("summary") as CodexLlmProviderConfig["summary"] | undefined
    const llm = resolveStrategyLlmConfig({
        dryRun: true,
        llm: {
            provider: "codex",
            model,
            authMode,
            effort,
            summary,
            codexBin,
        },
    })

    if (llm.provider !== "codex") {
        throw new Error("Codex preflight resolved a non-Codex provider")
    }

    return {
        llm,
        source: "synthetic dry-run preflight",
        strategySecrets: {},
    }
}

function createPreflightContext(llm: CodexLlmProviderConfig): StrategyRunContext {
    return {
        runId: `codex-preflight-${Date.now()}`,
        strategyId: "codex-preflight",
        app: "polymarket",
        timestamp: Date.now(),
        trigger: "manual",
        positions: [],
        accountState: {
            balance: 10_000,
            equity: 10_000,
            buyingPower: 10_000,
            marginUsed: 0,
            marginAvailable: 10_000,
            openPnl: 0,
            dayPnl: 0,
        },
        policy: {
            dryRun: true,
            llm,
        },
        context: [
            "This is a Codex provider preflight.",
            "Call preflight_echo exactly once with value mcp-ready before writing the final response.",
            "Do not place, adjust, cancel, or close any order.",
            "Return a concise final message saying Codex provider preflight complete.",
        ].join("\n"),
    }
}

function readCodexVersion(command: string): string {
    const result = Bun.spawnSync([command, "--version"], {
        stdout: "pipe",
        stderr: "pipe",
    })
    const stdout = new TextDecoder().decode(result.stdout).trim()
    const stderr = new TextDecoder().decode(result.stderr).trim()

    if (result.exitCode !== 0) {
        throw new Error(`Codex binary check failed: ${stderr || stdout || `exit ${result.exitCode}`}`)
    }

    return stdout || "unknown"
}

function resolveAuthMode(value: string): CodexLlmProviderConfig["authMode"] {
    if (value === "chatgpt") {
        return value
    }

    throw new Error("--auth-mode must be chatgpt")
}

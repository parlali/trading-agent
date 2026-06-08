import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startRunToolServer, type RunToolServer } from "../../mcp/run-tool-server"
import type { ConversationManager } from "../../conversation"
import type { ToolExecutionFatalFault } from "../../tool-execution-engine"
import type { LLMUsage } from "../openrouter/openrouter-chat-client"
import type { AgentModelProvider, AgentProviderDiagnostics, AgentProviderRunArgs, AgentProviderRunResult } from "../types"
import {
    CodexJsonRpcClient,
    type JsonRpcErrorPayload,
    type JsonRpcId,
    type JsonRpcMessage,
} from "./codex-json-rpc-client"
import type {
    CodexAccountReadResponse,
    CodexAuthStatus,
    CodexTokenUsageNotification,
    CodexTurn,
    CodexTurnCompletion,
} from "./codex-app-server-protocol"

export type CodexAuthMode = "chatgpt" | "access-token" | "api-key"
export type CodexReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
export type CodexReasoningSummary = "auto" | "concise" | "detailed" | "none"

export interface CodexAppServerProviderConfig {
    provider: "codex"
    model: string
    effort?: CodexReasoningEffort
    summary?: CodexReasoningSummary
    serviceTier?: string
    authMode: CodexAuthMode
    codexBin?: string
    codexAccessToken?: string
    openAiApiKey?: string
    requestTimeoutMs?: number
    turnTimeoutMs?: number
    runDirectory?: string
    appServerArgs?: string[]
}

export interface CodexAppServerClient {
    initialize(): Promise<unknown>
    request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>
    respond(id: JsonRpcId, result: unknown): Promise<void>
    reject(id: JsonRpcId, error: JsonRpcErrorPayload): Promise<void>
    close(): void
}

interface PendingTurnCompletion {
    threadId: string
    turnId: string
    resolve(completion: CodexTurnCompletion): void
    reject(error: Error): void
    timer: ReturnType<typeof setTimeout>
}

export interface CodexAppServerClientFactoryArgs {
    config: CodexAppServerProviderConfig
    runArgs: AgentProviderRunArgs
    mcpServer: RunToolServer
    runDirectory: string
    onNotification: (message: JsonRpcMessage) => void
    onServerRequest: (message: JsonRpcMessage, client: CodexAppServerClient) => Promise<void> | void
}

export interface CodexAppServerProviderDependencies {
    startRunToolServer?: typeof startRunToolServer
    createClient?: (args: CodexAppServerClientFactoryArgs) => CodexAppServerClient
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000
const MCP_TOKEN_ENV_VAR = "VALIQ_CODEX_MCP_TOKEN"
const MCP_SERVER_NAME = "valiq_run"
const DISABLED_CODEX_FEATURE_NAMES = [
    "apps",
    "browser_use",
    "browser_use_external",
    "computer_use",
    "image_generation",
    "multi_agent",
    "plugins",
    "shell_tool",
    "unified_exec",
    "web_search",
    "web_search_cached",
    "web_search_request",
    "workspace_dependencies",
] as const
const DISABLED_INHERITED_MCP_SERVER_NAMES = [
    "openaiDeveloperDocs",
] as const
const DISABLED_INHERITED_PLUGIN_NAMES = [
    "browser@openai-bundled",
    "documents@openai-primary-runtime",
    "github@openai-curated",
    "presentations@openai-primary-runtime",
    "spreadsheets@openai-primary-runtime",
] as const

export class CodexAppServerProvider implements AgentModelProvider {
    readonly provider = "codex" as const
    private client: CodexAppServerClient | undefined
    private mcpServer: RunToolServer | undefined
    private runDirectoryToRemove: string | undefined
    private currentThreadId: string | undefined
    private currentTurnId: string | undefined
    private pendingCompletion: PendingTurnCompletion | undefined
    private completedTurns = new Map<string, CodexTurnCompletion>()
    private assistantContent = ""
    private latestUsage: LLMUsage = createEmptyUsage()
    private rateLimitSnapshotAfterNotification: unknown
    private forbiddenCapabilityError: string | undefined
    private cancellationRequested = false

    constructor(
        private readonly config: CodexAppServerProviderConfig,
        private readonly dependencies: CodexAppServerProviderDependencies = {}
    ) {}

    async run(args: AgentProviderRunArgs): Promise<AgentProviderRunResult> {
        this.resetRunState()
        const diagnostics = createBaseDiagnostics(this.config)
        let rateLimitSnapshotBefore: unknown
        let rateLimitSnapshotAfter: unknown
        let iterations = 0

        try {
            const runDirectory = await this.resolveRunDirectory()
            const runToolServerFactory = this.dependencies.startRunToolServer ?? startRunToolServer
            this.mcpServer = await runToolServerFactory({
                tools: args.tools,
                toolEngine: args.toolEngine,
                logger: args.logger,
                onFatalFault: async () => {
                    await this.interruptCurrentTurn(args, "shared tool execution reported a fatal fault")
                },
            })

            this.client = this.createClient(args, this.mcpServer, runDirectory)
            await this.client.initialize()

            const authStatus = await this.readAuthStatus()
            diagnostics.authMode = authStatus.authMethod ?? "missing"
            diagnostics.billingMode = resolveBillingMode(this.config.authMode)
            assertCodexAuthMode(this.config.authMode, authStatus)

            rateLimitSnapshotBefore = await this.readRateLimits()
            diagnostics.rateLimitSnapshotBefore = rateLimitSnapshotBefore

            const { baseInstructions, userMessage } = readCodexPromptParts(args.conversation)
            const threadResponse = await this.client.request("thread/start", {
                model: this.config.model,
                serviceTier: this.config.serviceTier ?? null,
                cwd: runDirectory,
                runtimeWorkspaceRoots: [],
                approvalPolicy: "never",
                approvalsReviewer: "user",
                sandbox: "read-only",
                config: buildCodexThreadConfig(this.mcpServer),
                baseInstructions,
                developerInstructions: null,
                personality: null,
                ephemeral: true,
                environments: [],
                dynamicTools: [],
            }, this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)

            this.currentThreadId = readThreadId(threadResponse)
            diagnostics.codexThreadId = this.currentThreadId
            if (this.forbiddenCapabilityError) {
                throw new Error(this.forbiddenCapabilityError)
            }

            iterations = 1
            const turnId = await this.startTurn(this.currentThreadId, userMessage, runDirectory)
            diagnostics.codexTurnIds = [turnId]
            const completion = await this.waitForTurnCompletion(this.currentThreadId, turnId)

            rateLimitSnapshotAfter = await this.readRateLimits()
            diagnostics.rateLimitSnapshotAfter = rateLimitSnapshotAfter

            const fatalFault = args.toolEngine.getOutcome().fatalFault
            const forbiddenError = this.forbiddenCapabilityError
            const completionError = resolveTurnCompletionError(completion.turn)
            const summary = this.assistantContent.trim()
            const error = forbiddenError ??
                resolveFatalFaultError(args.context.runId, fatalFault) ??
                completionError ??
                undefined

            if (summary.length > 0) {
                args.conversation.addAssistantMessage(summary)
                await args.agentLogger?.log(
                    args.context.runId,
                    args.context.strategyId,
                    args.conversation.getSequence(),
                    "assistant",
                    summary
                )
            }

            args.logger.info("Codex app-server run complete", {
                runId: args.context.runId,
                threadId: this.currentThreadId,
                turnId,
                status: completion.turn.status,
                usage: this.latestUsage,
            })

            return {
                summary,
                error,
                iterations,
                usage: this.latestUsage,
                diagnostics: {
                    ...diagnostics,
                    responseIds: [],
                    rateLimitSnapshotBefore,
                    rateLimitSnapshotAfter,
                },
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            args.logger.error("Codex app-server provider failed", {
                runId: args.context.runId,
                error: message,
            })

            return {
                summary: this.assistantContent.trim(),
                error: message,
                iterations,
                usage: this.latestUsage,
                diagnostics: {
                    ...diagnostics,
                    responseIds: [],
                    codexThreadId: this.currentThreadId,
                    codexTurnIds: this.currentTurnId ? [this.currentTurnId] : undefined,
                    rateLimitSnapshotBefore,
                    rateLimitSnapshotAfter: rateLimitSnapshotAfter ?? this.rateLimitSnapshotAfterNotification,
                },
            }
        } finally {
            await this.closeRunResources(args)
        }
    }

    cancel(): void {
        this.cancellationRequested = true
        if (this.currentThreadId && this.currentTurnId && this.client) {
            void this.client.request("turn/interrupt", {
                threadId: this.currentThreadId,
                turnId: this.currentTurnId,
            }).catch(() => undefined)
        }
        this.client?.close()
        void this.mcpServer?.close().catch(() => undefined)
    }

    private async resolveRunDirectory(): Promise<string> {
        if (this.config.runDirectory) {
            return this.config.runDirectory
        }

        const directory = await mkdtemp(join(tmpdir(), "valiq-codex-run-"))
        this.runDirectoryToRemove = directory
        return directory
    }

    private createClient(
        args: AgentProviderRunArgs,
        mcpServer: RunToolServer,
        runDirectory: string
    ): CodexAppServerClient {
        const onNotification = (message: JsonRpcMessage) => this.handleNotification(message, args)
        const onServerRequest = async (message: JsonRpcMessage, client: CodexAppServerClient) => {
            await this.handleServerRequest(message, client, args)
        }

        if (this.dependencies.createClient) {
            return this.dependencies.createClient({
                config: this.config,
                runArgs: args,
                mcpServer,
                runDirectory,
                onNotification,
                onServerRequest,
            })
        }

        return CodexJsonRpcClient.spawn({
            command: this.config.codexBin ?? "codex",
            args: buildCodexAppServerArgs(this.config, mcpServer),
            cwd: runDirectory,
            env: buildCodexEnvironment(this.config, mcpServer.token),
            logger: args.logger,
            requestTimeoutMs: this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
            onNotification,
            onServerRequest: async (message, client) => await onServerRequest(message, client),
        })
    }

    private async readAuthStatus(): Promise<CodexAuthStatus> {
        const result = await this.requireClient().request("account/read", {
            refreshToken: false,
        })
        return normalizeCodexAuthStatus(
            readRecord(result) as CodexAccountReadResponse | CodexAuthStatus | undefined,
            this.config.authMode
        )
    }

    private async readRateLimits(): Promise<unknown> {
        const result = await this.requireClient().request("account/rateLimits/read", undefined)
        const record = readRecord(result)
        return record?.rateLimits ?? result
    }

    private async startTurn(
        threadId: string,
        userMessage: string,
        runDirectory: string
    ): Promise<string> {
        const response = await this.requireClient().request("turn/start", {
            threadId,
            input: [{
                type: "text",
                text: userMessage,
                text_elements: [],
            }],
            cwd: runDirectory,
            runtimeWorkspaceRoots: [],
            approvalPolicy: "never",
            approvalsReviewer: "user",
            sandbox: "read-only",
            model: this.config.model,
            serviceTier: this.config.serviceTier ?? null,
            effort: this.config.effort ?? null,
            summary: this.config.summary ?? null,
            personality: null,
            environments: [],
        }, this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)

        const turnId = readTurnId(response)
        this.currentTurnId = turnId
        return turnId
    }

    private waitForTurnCompletion(threadId: string, turnId: string): Promise<CodexTurnCompletion> {
        const key = turnCompletionKey(threadId, turnId)
        const completed = this.completedTurns.get(key)
        if (completed) {
            this.completedTurns.delete(key)
            return Promise.resolve(completed)
        }

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingCompletion = undefined
                reject(new Error(`Codex turn timed out after ${Math.round((this.config.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS) / 1000)}s`))
            }, this.config.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS)

            this.pendingCompletion = {
                threadId,
                turnId,
                resolve,
                reject,
                timer,
            }
        })
    }

    private handleNotification(message: JsonRpcMessage, args: AgentProviderRunArgs): void {
        if (message.method === "item/agentMessage/delta") {
            const params = readRecord(message.params)
            const delta = typeof params?.delta === "string" ? params.delta : ""
            this.assistantContent += delta
            return
        }

        if (message.method === "thread/tokenUsage/updated") {
            this.latestUsage = convertCodexUsage(readRecord(message.params) as CodexTokenUsageNotification | undefined)
            return
        }

        if (message.method === "account/rateLimits/updated") {
            const params = readRecord(message.params)
            this.rateLimitSnapshotAfterNotification = params?.rateLimits
            return
        }

        if (message.method === "turn/completed") {
            this.resolvePendingTurnCompletion(message)
            return
        }

        if (message.method === "mcpServer/startupStatus/updated") {
            const startup = readMcpStartupStatus(message.params)
            if (startup.name && startup.name !== MCP_SERVER_NAME && startup.status !== "disabled") {
                const reason = `Codex started non-run MCP server ${startup.name} with status ${startup.status ?? "unknown"}`
                this.forbiddenCapabilityError = reason
                args.logger.error("Codex started non-run MCP server", {
                    runId: args.context.runId,
                    name: startup.name,
                    status: startup.status,
                })
                void this.interruptCurrentTurn(args, reason)
            }
            args.logger.info("Codex MCP startup status updated", {
                params: message.params,
                runId: args.context.runId,
            })
            return
        }

        if (message.method === "error" || message.method === "warning" || message.method === "configWarning" || message.method === "guardianWarning") {
            args.logger.warn("Codex app-server notification", {
                method: message.method,
                params: message.params,
                runId: args.context.runId,
            })
        }
    }

    private resolvePendingTurnCompletion(message: JsonRpcMessage): void {
        const params = readRecord(message.params)
        const threadId = typeof params?.threadId === "string" ? params.threadId : ""
        const turn = readRecord(params?.turn) as CodexTurn | undefined
        const turnId = typeof turn?.id === "string" ? turn.id : ""
        if (!threadId || !turnId) {
            return
        }

        const completion = {
            threadId,
            turn: turn ?? {},
        }
        const pending = this.pendingCompletion
        if (!pending) {
            this.completedTurns.set(turnCompletionKey(threadId, turnId), completion)
            return
        }

        if (threadId !== pending.threadId || turnId !== pending.turnId) {
            this.completedTurns.set(turnCompletionKey(threadId, turnId), completion)
            return
        }

        clearTimeout(pending.timer)
        this.pendingCompletion = undefined
        this.completedTurns.delete(turnCompletionKey(threadId, turnId))
        pending.resolve(completion)
    }

    private async handleServerRequest(
        message: JsonRpcMessage,
        client: CodexAppServerClient,
        args: AgentProviderRunArgs
    ): Promise<void> {
        const method = message.method ?? "unknown"
        const id = message.id
        if (id === undefined) {
            return
        }

        const reason = `Codex attempted forbidden capability through ${method}`
        this.forbiddenCapabilityError = reason
        args.logger.error("Codex requested forbidden capability", {
            runId: args.context.runId,
            method,
        })

        if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
            await client.respond(id, { decision: "decline" })
        } else if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
            await client.respond(id, { decision: "decline" })
        } else if (method === "item/permissions/requestApproval") {
            await client.reject(id, {
                code: -32000,
                message: reason,
            })
        } else {
            await client.reject(id, {
                code: -32000,
                message: reason,
            })
        }

        await this.interruptCurrentTurn(args, reason)
    }

    private async interruptCurrentTurn(args: AgentProviderRunArgs, reason: string): Promise<void> {
        if (!this.currentThreadId || !this.currentTurnId || !this.client || this.cancellationRequested) {
            return
        }

        args.logger.error("Interrupting Codex turn", {
            runId: args.context.runId,
            threadId: this.currentThreadId,
            turnId: this.currentTurnId,
            reason,
        })

        await this.client.request("turn/interrupt", {
            threadId: this.currentThreadId,
            turnId: this.currentTurnId,
        }).catch((error) => {
            args.logger.error("Codex turn interrupt failed", {
                runId: args.context.runId,
                error: error instanceof Error ? error.message : String(error),
            })
        })
    }

    private requireClient(): CodexAppServerClient {
        if (!this.client) {
            throw new Error("Codex app-server client is not started")
        }
        return this.client
    }

    private async closeRunResources(args: AgentProviderRunArgs): Promise<void> {
        const pending = this.pendingCompletion
        if (pending) {
            clearTimeout(pending.timer)
            pending.reject(new Error("Codex run resources closed before turn completion"))
            this.pendingCompletion = undefined
        }

        this.client?.close()
        this.client = undefined

        if (this.mcpServer) {
            await this.mcpServer.close().catch((error) => {
                args.logger.error("Run MCP server shutdown failed", {
                    runId: args.context.runId,
                    error: error instanceof Error ? error.message : String(error),
                })
            })
            this.mcpServer = undefined
        }

        if (this.runDirectoryToRemove) {
            await rm(this.runDirectoryToRemove, {
                recursive: true,
                force: true,
            }).catch((error) => {
                args.logger.warn("Codex run directory cleanup failed", {
                    runId: args.context.runId,
                    error: error instanceof Error ? error.message : String(error),
                })
            })
            this.runDirectoryToRemove = undefined
        }
        this.completedTurns.clear()
    }

    private resetRunState(): void {
        const pending = this.pendingCompletion
        if (pending) {
            clearTimeout(pending.timer)
            pending.reject(new Error("Codex provider run state reset before turn completion"))
        }
        this.currentThreadId = undefined
        this.currentTurnId = undefined
        this.pendingCompletion = undefined
        this.completedTurns.clear()
        this.assistantContent = ""
        this.latestUsage = createEmptyUsage()
        this.rateLimitSnapshotAfterNotification = undefined
        this.forbiddenCapabilityError = undefined
        this.cancellationRequested = false
    }
}

function buildCodexAppServerArgs(
    config: CodexAppServerProviderConfig,
    mcpServer: RunToolServer
): string[] {
    const overrides = buildCodexConfigOverrides(config, mcpServer)
    return [
        "app-server",
        "--strict-config",
        ...(config.appServerArgs ?? []),
        ...overrides.flatMap(([key, value]) => ["-c", `${key}=${value}`]),
    ]
}

function buildCodexConfigOverrides(
    config: CodexAppServerProviderConfig,
    mcpServer: RunToolServer
): Array<[string, string]> {
    const overrides: Array<[string, string]> = [
        ["web_search", tomlString("disabled")],
        ["approval_policy", tomlString("never")],
        ["approvals_reviewer", tomlString("user")],
        ["sandbox_mode", tomlString("read-only")],
        ["allow_login_shell", "false"],
        ...DISABLED_CODEX_FEATURE_NAMES.map((name) =>
            [`features.${name}`, "false"] as [string, string]
        ),
        ...DISABLED_INHERITED_PLUGIN_NAMES.map((name) =>
            [`plugins.${tomlQuotedPathSegment(name)}.enabled`, "false"] as [string, string]
        ),
        ...DISABLED_INHERITED_MCP_SERVER_NAMES.map((name) =>
            [`mcp_servers.${name}.enabled`, "false"] as [string, string]
        ),
        [`mcp_servers.${MCP_SERVER_NAME}.enabled`, "true"],
        [`mcp_servers.${MCP_SERVER_NAME}.required`, "true"],
        [`mcp_servers.${MCP_SERVER_NAME}.url`, tomlString(mcpServer.url)],
        [`mcp_servers.${MCP_SERVER_NAME}.bearer_token_env_var`, tomlString(MCP_TOKEN_ENV_VAR)],
        [`mcp_servers.${MCP_SERVER_NAME}.enabled_tools`, tomlStringArray(mcpServer.toolNames)],
        [`mcp_servers.${MCP_SERVER_NAME}.default_tools_approval_mode`, tomlString("approve")],
        [`mcp_servers.${MCP_SERVER_NAME}.tool_timeout_sec`, "120.0"],
    ]

    if (config.effort) {
        overrides.push(["model_reasoning_effort", tomlString(config.effort)])
    }
    if (config.summary) {
        overrides.push(["model_reasoning_summary", tomlString(config.summary)])
    }
    if (config.serviceTier) {
        overrides.push(["service_tier", tomlString(config.serviceTier)])
    }

    return overrides
}

function buildCodexThreadConfig(mcpServer: RunToolServer): Record<string, unknown> {
    return {
        web_search: "disabled",
        approval_policy: "never",
        approvals_reviewer: "user",
        sandbox_mode: "read-only",
        allow_login_shell: false,
        features: Object.fromEntries(DISABLED_CODEX_FEATURE_NAMES.map((name) => [name, false])),
        plugins: Object.fromEntries(DISABLED_INHERITED_PLUGIN_NAMES.map((name) => [
            name,
            {
                enabled: false,
            },
        ])),
        mcp_servers: {
            ...Object.fromEntries(DISABLED_INHERITED_MCP_SERVER_NAMES.map((name) => [
                name,
                {
                    enabled: false,
                },
            ])),
            [MCP_SERVER_NAME]: {
                enabled: true,
                required: true,
                url: mcpServer.url,
                bearer_token_env_var: MCP_TOKEN_ENV_VAR,
                enabled_tools: mcpServer.toolNames,
                default_tools_approval_mode: "approve",
                tool_timeout_sec: 120,
            },
        },
    }
}

export function buildCodexEnvironment(
    config: CodexAppServerProviderConfig,
    mcpToken: string
): Record<string, string | undefined> {
    const env = pickCodexEnvironment(process.env, [
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "SHELL",
        "TMPDIR",
        "TEMP",
        "TMP",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "CODEX_HOME",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "NO_PROXY",
    ])

    return withCodexCredentials({
        ...env,
        [MCP_TOKEN_ENV_VAR]: mcpToken,
    }, config)
}

function pickCodexEnvironment(
    env: Record<string, string | undefined>,
    names: string[]
): Record<string, string | undefined> {
    return Object.fromEntries(
        names
            .map((name) => [name, env[name]] as const)
            .filter((entry): entry is readonly [string, string] => entry[1] !== undefined)
    )
}

function withCodexCredentials(
    env: Record<string, string | undefined>,
    config: CodexAppServerProviderConfig
): Record<string, string | undefined> {
    if (config.authMode === "access-token") {
        const accessToken = config.codexAccessToken ?? process.env.CODEX_ACCESS_TOKEN
        if (!accessToken) {
            throw new Error("Cannot run Codex provider: CODEX_ACCESS_TOKEN is required for access-token auth")
        }
        env.CODEX_ACCESS_TOKEN = accessToken
    }

    if (config.authMode === "api-key") {
        const apiKey = config.openAiApiKey ?? process.env.OPENAI_API_KEY
        if (!apiKey) {
            throw new Error("Cannot run Codex provider: OPENAI_API_KEY is required for api-key auth")
        }
        env.OPENAI_API_KEY = apiKey
    }

    return env
}

function assertCodexAuthMode(expected: CodexAuthMode, status: CodexAuthStatus): void {
    const method = status.authMethod
    const allowed = expected === "chatgpt"
        ? ["chatgpt", "chatgptAuthTokens"]
        : expected === "access-token"
            ? ["agentIdentity"]
            : ["apikey"]

    if (!method || !allowed.includes(method)) {
        throw new Error(`Codex auth mode mismatch: expected ${expected}, app-server reported ${method ?? "missing"}`)
    }
}

function normalizeCodexAuthStatus(
    status: CodexAccountReadResponse | CodexAuthStatus | undefined,
    expected: CodexAuthMode
): CodexAuthStatus {
    if (!status) {
        return { authMethod: null }
    }

    if ("authMethod" in status && status.authMethod !== undefined) {
        return status as CodexAuthStatus
    }

    const accountRead = status as CodexAccountReadResponse
    const authMode = accountRead.authMode
    if (authMode) {
        return {
            authMethod: authMode,
            requiresOpenaiAuth: accountRead.requiresOpenaiAuth,
        }
    }

    const accountType = accountRead.account?.type
    if (accountType === "apiKey") {
        return {
            authMethod: "apikey",
            requiresOpenaiAuth: accountRead.requiresOpenaiAuth,
        }
    }
    if (accountType === "chatgpt") {
        return {
            authMethod: "chatgpt",
            requiresOpenaiAuth: accountRead.requiresOpenaiAuth,
        }
    }
    if (accountType === "agentIdentity") {
        return {
            authMethod: "agentIdentity",
            requiresOpenaiAuth: accountRead.requiresOpenaiAuth,
        }
    }
    if (expected === "access-token" && accountRead.requiresOpenaiAuth === false) {
        return {
            authMethod: "agentIdentity",
            requiresOpenaiAuth: false,
        }
    }

    return {
        authMethod: null,
        requiresOpenaiAuth: accountRead.requiresOpenaiAuth,
    }
}

function resolveBillingMode(authMode: CodexAuthMode): string {
    return authMode === "api-key" ? "platform-api" : "codex-subscription"
}

function readCodexPromptParts(conversation: ConversationManager): {
    baseInstructions: string
    userMessage: string
} {
    const messages = conversation.getMessages()
    const baseInstructions = messages
        .filter((message) => message.role === "system" && typeof message.content === "string")
        .map((message) => message.content)
        .join("\n\n")
    const userMessages = messages
        .filter((message) => message.role === "user" && typeof message.content === "string")
        .map((message) => message.content)

    return {
        baseInstructions,
        userMessage: userMessages[userMessages.length - 1] ?? "Begin the strategy run.",
    }
}

function readMcpStartupStatus(value: unknown): {
    name?: string
    status?: string
} {
    const params = readRecord(value)
    const name = typeof params?.name === "string" ? params.name : undefined
    const status = typeof params?.status === "string" ? params.status : undefined

    return {
        name,
        status,
    }
}

function readThreadId(response: unknown): string {
    const record = readRecord(response)
    const thread = readRecord(record?.thread)
    const id = thread?.id
    if (typeof id !== "string" || id.length === 0) {
        throw new Error("Codex thread/start did not return a thread id")
    }
    return id
}

function readTurnId(response: unknown): string {
    const record = readRecord(response)
    const turn = readRecord(record?.turn)
    const id = turn?.id
    if (typeof id !== "string" || id.length === 0) {
        throw new Error("Codex turn/start did not return a turn id")
    }
    return id
}

function resolveTurnCompletionError(turn: CodexTurn): string | undefined {
    if (turn.status === "completed") {
        return undefined
    }

    const message = turn.error?.message ?? `Codex turn ended with status ${turn.status ?? "unknown"}`
    const details = turn.error?.additionalDetails
    return details ? `${message}: ${details}` : message
}

function resolveFatalFaultError(runId: string, fatalFault: ToolExecutionFatalFault | undefined): string | undefined {
    return fatalFault
        ? `Circuit breaker: ${fatalFault.reason} in run ${runId}: ${fatalFault.toolResult}`
        : undefined
}

function convertCodexUsage(usage: CodexTokenUsageNotification | undefined): LLMUsage {
    const last = usage?.tokenUsage?.last ?? usage?.tokenUsage?.total
    return {
        promptTokens: readNumber(last?.inputTokens),
        completionTokens: readNumber(last?.outputTokens),
        reasoningTokens: readNumber(last?.reasoningOutputTokens),
        cost: 0,
        responseIds: [],
    }
}

function createEmptyUsage(): LLMUsage {
    return {
        promptTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        cost: 0,
        responseIds: [],
    }
}

function createBaseDiagnostics(config: CodexAppServerProviderConfig): AgentProviderDiagnostics {
    return {
        provider: "codex" as const,
        model: config.model,
        authMode: config.authMode,
        billingMode: resolveBillingMode(config.authMode),
        responseIds: [],
    }
}

function turnCompletionKey(threadId: string, turnId: string): string {
    return `${threadId}:${turnId}`
}

function tomlString(value: string): string {
    return JSON.stringify(value)
}

function tomlStringArray(values: string[]): string {
    return `[${values.map((value) => tomlString(value)).join(", ")}]`
}

function tomlQuotedPathSegment(value: string): string {
    return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined
}

function readNumber(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0
}

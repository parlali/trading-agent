import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { safeLogAgentMessage } from "../../agent-transcript"
import { createEmptyUsage, type LLMUsage } from "../../llm-usage"
import { startRunToolServer, type RunToolServer } from "../../mcp/run-tool-server"
import type { ConversationManager } from "../../conversation"
import type { ToolExecutionFatalFault } from "../../tool-execution-engine"
import type { AgentModelProvider, AgentProviderDiagnostics, AgentProviderRunArgs, AgentProviderRunResult } from "../types"
import {
    CODEX_RUN_MCP_SERVER_NAME,
    DEFAULT_REQUEST_TIMEOUT_MS,
    DEFAULT_TURN_TIMEOUT_MS,
    buildCodexAppServerArgs,
    buildCodexEnvironment,
    buildCodexThreadConfig,
    resolveBillingMode,
    type CodexAppServerProviderConfig,
    type CodexAuthMode,
    type CodexChatGptAuthRefreshSnapshot,
} from "./codex-app-server-config"
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

export { buildCodexEnvironment } from "./codex-app-server-config"
export type {
    CodexAppServerProviderConfig,
    CodexAuthMode,
    CodexChatGptAuthRefreshSnapshot,
    CodexReasoningEffort,
    CodexReasoningSummary,
} from "./codex-app-server-config"

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
    env: Record<string, string | undefined>
    onNotification: (message: JsonRpcMessage) => void
    onServerRequest: (message: JsonRpcMessage, client: CodexAppServerClient) => Promise<void> | void
}

export interface CodexAppServerProviderDependencies {
    startRunToolServer?: typeof startRunToolServer
    createClient?: (args: CodexAppServerClientFactoryArgs) => CodexAppServerClient
}

const KILL_SWITCH_POLL_MS = 1000
let codexChatGptAuthRefreshLock: Promise<void> = Promise.resolve()

export class CodexAppServerProvider implements AgentModelProvider {
    readonly provider = "codex" as const
    private client: CodexAppServerClient | undefined
    private mcpServer: RunToolServer | undefined
    private runDirectoryToRemove: string | undefined
    private runAbortController: AbortController | undefined
    private currentThreadId: string | undefined
    private currentTurnId: string | undefined
    private pendingCompletion: PendingTurnCompletion | undefined
    private completedTurns = new Map<string, CodexTurnCompletion>()
    private assistantContent = ""
    private assistantSummaryPersisted = false
    private latestUsage: LLMUsage = createEmptyUsage()
    private rateLimitSnapshotAfterNotification: unknown
    private forbiddenCapabilityError: string | undefined
    private cancellationRequested = false
    private sourceChatGptAuthFile: string | undefined
    private isolatedChatGptAuthFile: string | undefined

    constructor(
        private readonly config: CodexAppServerProviderConfig,
        private readonly dependencies: CodexAppServerProviderDependencies = {}
    ) {}

    async run(args: AgentProviderRunArgs): Promise<AgentProviderRunResult> {
        this.resetRunState()
        this.runAbortController = new AbortController()
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
                signal: this.runAbortController.signal,
                onFatalFault: async () => {
                    const reason = resolveFatalFaultError(args.context.runId, args.toolEngine.getOutcome().fatalFault) ??
                        "shared tool execution reported a fatal fault"
                    this.failCurrentRun(reason)
                    await this.interruptCurrentTurn(args, reason)
                },
            })

            const authStatus = await this.startClientAndReadAuth(args, this.mcpServer, runDirectory)
            diagnostics.authMode = authStatus.authMethod ?? "missing"
            diagnostics.billingMode = resolveBillingMode(this.config.authMode)
            assertCodexAuthMode(this.config.authMode, authStatus)

            rateLimitSnapshotBefore = await this.readRateLimits()
            diagnostics.rateLimitSnapshotBefore = rateLimitSnapshotBefore

            const { baseInstructions, userMessage } = readCodexPromptParts(args.conversation)
            const threadResponse = await this.requireClient().request("thread/start", {
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
            const completion = await this.waitForTurnCompletionWithRunControl(args, this.currentThreadId, turnId)

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

            await this.persistAssistantSummary(args, summary)

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

            const summary = this.assistantContent.trim()
            await this.persistAssistantSummary(args, summary)

            return {
                summary,
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
        this.runAbortController?.abort()
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
        runDirectory: string,
        env: Record<string, string | undefined>
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
                env,
                onNotification,
                onServerRequest,
            })
        }

        return CodexJsonRpcClient.spawn({
            command: this.config.codexBin ?? "codex",
            args: buildCodexAppServerArgs(this.config, mcpServer),
            cwd: runDirectory,
            env,
            logger: args.logger,
            requestTimeoutMs: this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
            onNotification,
            onServerRequest: async (message, client) => await onServerRequest(message, client),
        })
    }

    private async startClientAndReadAuth(
        args: AgentProviderRunArgs,
        mcpServer: RunToolServer,
        runDirectory: string
    ): Promise<CodexAuthStatus> {
        const start = async () => {
            const clientEnv = await this.buildRunCodexEnvironment(runDirectory, mcpServer.token)
            this.client = this.createClient(args, mcpServer, runDirectory, clientEnv)
            await this.client.initialize()

            const authStatus = await this.readAuthStatus()
            await this.persistRefreshedChatGptAuth(args)
            return authStatus
        }

        if (this.config.authMode !== "chatgpt") {
            return await start()
        }

        return await withCodexChatGptAuthRefreshLock(start)
    }

    private async buildRunCodexEnvironment(
        runDirectory: string,
        mcpToken: string
    ): Promise<Record<string, string | undefined>> {
        const env = buildCodexEnvironment(this.config, mcpToken)
        if (this.config.authMode !== "chatgpt") {
            return env
        }

        const sourceCodexHome = resolveSourceCodexHome(env)
        const isolatedCodexHome = join(runDirectory, "codex-home")
        await mkdir(isolatedCodexHome, {
            recursive: true,
            mode: 0o700,
        })

        const sourceAuthFile = join(sourceCodexHome, "auth.json")
        const isolatedAuthFile = join(isolatedCodexHome, "auth.json")
        this.sourceChatGptAuthFile = sourceAuthFile
        this.isolatedChatGptAuthFile = isolatedAuthFile
        try {
            await copyFile(sourceAuthFile, isolatedAuthFile)
        } catch (error) {
            if (isNotFoundError(error)) {
                throw new Error(`Cannot run Codex provider: ChatGPT auth file missing at ${sourceAuthFile}`)
            }
            throw error
        }

        return {
            ...env,
            CODEX_HOME: isolatedCodexHome,
        }
    }

    private async readAuthStatus(): Promise<CodexAuthStatus> {
        const result = await this.requireClient().request("account/read", {
            refreshToken: this.config.authMode === "chatgpt",
        })
        return normalizeCodexAuthStatus(
            readRecord(result) as CodexAccountReadResponse | CodexAuthStatus | undefined,
            this.config.authMode
        )
    }

    private async persistRefreshedChatGptAuth(args: AgentProviderRunArgs): Promise<void> {
        const sourceAuthFile = this.sourceChatGptAuthFile
        const isolatedAuthFile = this.isolatedChatGptAuthFile
        if (!sourceAuthFile || !isolatedAuthFile) {
            return
        }

        let sourceAuthJson: string
        let isolatedAuthJson: string
        try {
            [sourceAuthJson, isolatedAuthJson] = await Promise.all([
                readFile(sourceAuthFile, "utf8"),
                readFile(isolatedAuthFile, "utf8"),
            ])
        } catch (error) {
            args.logger.warn("Codex ChatGPT auth refresh persistence read failed", {
                runId: args.context.runId,
                error: error instanceof Error ? error.message : String(error),
            })
            return
        }

        if (!shouldPersistChatGptAuthUpdate(sourceAuthJson, isolatedAuthJson)) {
            return
        }

        const temporaryAuthFile = `${sourceAuthFile}.${process.pid}.${Date.now()}.tmp`
        try {
            await writeFile(temporaryAuthFile, isolatedAuthJson, {
                mode: 0o600,
            })
            await chmod(temporaryAuthFile, 0o600)
            await rename(temporaryAuthFile, sourceAuthFile)
            await chmod(sourceAuthFile, 0o600)
            args.logger.info("Persisted refreshed Codex ChatGPT auth", {
                runId: args.context.runId,
            })
            const metadata = readChatGptAuthMetadata(isolatedAuthJson)
            if (metadata.accountId) {
                await this.persistRefreshedChatGptAuthSnapshot({
                    authJson: isolatedAuthJson,
                    accountId: metadata.accountId,
                    lastRefresh: metadata.lastRefresh,
                }, args)
            }
        } catch (error) {
            await rm(temporaryAuthFile, {
                force: true,
            }).catch(() => undefined)
            args.logger.warn("Codex ChatGPT auth refresh persistence failed", {
                runId: args.context.runId,
                error: error instanceof Error ? error.message : String(error),
            })
        }
    }

    private async persistRefreshedChatGptAuthSnapshot(
        auth: CodexChatGptAuthRefreshSnapshot,
        args: AgentProviderRunArgs
    ): Promise<void> {
        if (!this.config.onChatGptAuthRefreshed) {
            return
        }

        try {
            await this.config.onChatGptAuthRefreshed(auth)
        } catch (error) {
            args.logger.warn("Codex ChatGPT auth control-plane persistence failed", {
                runId: args.context.runId,
                error: error instanceof Error ? error.message : String(error),
            })
        }
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

    private async waitForTurnCompletionWithRunControl(
        args: AgentProviderRunArgs,
        threadId: string,
        turnId: string
    ): Promise<CodexTurnCompletion> {
        const remainingMs = args.runTimeoutMs - (Date.now() - args.runStartedAt)
        if (remainingMs <= 0) {
            const reason = `Run timed out before Codex turn completion (limit: ${Math.round(args.runTimeoutMs / 1000)}s)`
            this.failCurrentRun(reason)
            await this.interruptCurrentTurn(args, reason)
            throw new Error(reason)
        }

        const pollController = new AbortController()
        const killSwitchPromise = args.killSwitchChecker
            ? this.pollKillSwitch(args, pollController.signal)
            : undefined
        let timeoutId: ReturnType<typeof setTimeout> | undefined
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
                const reason = `Run timed out during Codex turn after ${Math.round(args.runTimeoutMs / 1000)}s`
                this.failCurrentRun(reason)
                void this.interruptCurrentTurn(args, reason)
                reject(new Error(reason))
            }, remainingMs)
        })

        try {
            return await Promise.race([
                this.waitForTurnCompletion(threadId, turnId),
                timeoutPromise,
                ...(killSwitchPromise ? [killSwitchPromise] : []),
            ])
        } finally {
            if (timeoutId) {
                clearTimeout(timeoutId)
            }
            pollController.abort()
            await killSwitchPromise?.catch(() => undefined)
        }
    }

    private async pollKillSwitch(
        args: AgentProviderRunArgs,
        signal: AbortSignal
    ): Promise<never> {
        while (!signal.aborted) {
            await delay(KILL_SWITCH_POLL_MS, signal)
            if (signal.aborted) {
                break
            }

            try {
                if (await args.killSwitchChecker?.()) {
                    const reason = "Kill switch activated during Codex run"
                    this.failCurrentRun(reason)
                    await this.interruptCurrentTurn(args, reason)
                    throw new Error(reason)
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                const reason = message === "Kill switch activated during Codex run"
                    ? message
                    : `Kill switch check failed: ${message}`
                this.failCurrentRun(reason)
                await this.interruptCurrentTurn(args, reason)
                throw new Error(reason)
            }
        }

        throw createAbortError("Codex kill-switch polling stopped")
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
            if (startup.name && startup.name !== CODEX_RUN_MCP_SERVER_NAME && startup.status !== "disabled") {
                const reason = `Codex started non-run MCP server ${startup.name} with status ${startup.status ?? "unknown"}`
                this.failCurrentRun(reason)
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
        this.failCurrentRun(reason)
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

    private failCurrentRun(reason: string): void {
        this.forbiddenCapabilityError = reason
        this.runAbortController?.abort()
        this.rejectPendingTurnCompletion(new Error(reason))
    }

    private rejectPendingTurnCompletion(error: Error): void {
        const pending = this.pendingCompletion
        if (!pending) {
            return
        }

        clearTimeout(pending.timer)
        this.pendingCompletion = undefined
        pending.reject(error)
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

    private async persistAssistantSummary(args: AgentProviderRunArgs, summary: string): Promise<void> {
        if (summary.length === 0 || this.assistantSummaryPersisted) {
            return
        }

        args.conversation.addAssistantMessage(summary)
        this.assistantSummaryPersisted = true
        await safeLogAgentMessage({
            agentLogger: args.agentLogger,
            logger: args.logger,
            runId: args.context.runId,
            strategyId: args.context.strategyId,
            sequence: args.conversation.getSequence(),
            role: "assistant",
            content: summary,
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
        this.runAbortController?.abort()
        this.runAbortController = undefined

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
        this.runAbortController?.abort()
        this.runAbortController = undefined
        this.pendingCompletion = undefined
        this.completedTurns.clear()
        this.assistantContent = ""
        this.assistantSummaryPersisted = false
        this.latestUsage = createEmptyUsage()
        this.rateLimitSnapshotAfterNotification = undefined
        this.forbiddenCapabilityError = undefined
        this.cancellationRequested = false
        this.sourceChatGptAuthFile = undefined
        this.isolatedChatGptAuthFile = undefined
    }
}

function shouldPersistChatGptAuthUpdate(sourceAuthJson: string, isolatedAuthJson: string): boolean {
    if (sourceAuthJson === isolatedAuthJson) {
        return false
    }

    const source = readChatGptAuthMetadata(sourceAuthJson)
    const isolated = readChatGptAuthMetadata(isolatedAuthJson)
    if (!isolated.accountId) {
        return false
    }
    if (source.accountId && source.accountId !== isolated.accountId) {
        return false
    }

    return isolated.lastRefreshMs >= source.lastRefreshMs
}

function readChatGptAuthMetadata(authJson: string): {
    accountId: string | undefined
    lastRefresh: string | undefined
    lastRefreshMs: number
} {
    try {
        const auth = readRecord(JSON.parse(authJson) as unknown)
        const tokens = readRecord(auth?.tokens)
        const accountId = typeof tokens?.account_id === "string" && tokens.account_id.trim()
            ? tokens.account_id
            : undefined
        const lastRefresh = typeof auth?.last_refresh === "string"
            ? Date.parse(auth.last_refresh)
            : NaN

        return {
            accountId,
            lastRefresh: typeof auth?.last_refresh === "string" && auth.last_refresh.trim()
                ? auth.last_refresh
                : undefined,
            lastRefreshMs: Number.isFinite(lastRefresh) ? lastRefresh : 0,
        }
    } catch {
        return {
            accountId: undefined,
            lastRefresh: undefined,
            lastRefreshMs: 0,
        }
    }
}

async function withCodexChatGptAuthRefreshLock<T>(run: () => Promise<T>): Promise<T> {
    const previous = codexChatGptAuthRefreshLock
    let release: () => void = () => undefined
    const current = new Promise<void>((resolve) => {
        release = resolve
    })
    codexChatGptAuthRefreshLock = previous.then(
        () => current,
        () => current
    )

    await previous.catch(() => undefined)
    try {
        return await run()
    } finally {
        release()
    }
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
    return {
        authMethod: null,
        requiresOpenaiAuth: accountRead.requiresOpenaiAuth,
    }
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

function readRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined
}

function resolveSourceCodexHome(env: Record<string, string | undefined>): string {
    return env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex")
}

function isNotFoundError(error: unknown): boolean {
    return readRecord(error)?.code === "ENOENT"
}

function readNumber(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function delay(delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
        return Promise.reject(createAbortError("Codex polling stopped"))
    }

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort)
            resolve()
        }, delayMs)
        const onAbort = () => {
            clearTimeout(timer)
            reject(createAbortError("Codex polling stopped"))
        }
        signal.addEventListener("abort", onAbort, { once: true })
    })
}

function createAbortError(message: string): Error {
    const error = new Error(message)
    error.name = "AbortError"
    return error
}

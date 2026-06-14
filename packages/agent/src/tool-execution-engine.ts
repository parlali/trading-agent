import { readFiniteNumber, type AgentMessageLogger, type Logger, type StrategyRunContext } from "@valiq-trading/core"
import { safeLogAgentMessage } from "./agent-transcript"
import type { ToolCall } from "./llm-client"
import { normalizeModelToolResultContent } from "./tool-result-content"
import { assertToolNotAborted, type ToolBinding, type ToolRegistry } from "./tool-registry"

export interface OpportunityCoverageMetrics {
    researched: number
    qualified: number
    rejectedByModel: number
    rejectedByRisk: number
    submitted: number
    filled: number
    closed: number
    realizedPnl: number
}

export interface DegradedResearchOutcome {
    active: boolean
    reasons: string[]
    toolFailureCount: number
    retryCount: number
    decisionUnderDegradedContext: boolean
}

export interface ToolExecutionFatalFault {
    toolName: string
    toolResult: string
    reason: string
}

export interface ToolExecutionOutcome {
    opportunityCoverage: OpportunityCoverageMetrics
    degradedResearch: (decisionTaken: boolean) => DegradedResearchOutcome
    fatalFault?: ToolExecutionFatalFault
    abortReason?: string
}

export interface OpenRouterToolExecutionResult {
    toolCallId: string
    toolName: string
    content: string
    rawInput: string
}

export interface McpToolExecutionResult {
    toolName: string
    content: string
    isError: boolean
    fatal: boolean
}

export interface ToolExecutionEngineConfig {
    tools: ToolRegistry
    context?: StrategyRunContext
    logger: Logger
    agentLogger?: AgentMessageLogger
    runStartedAt: number
    runTimeoutMs: number
    maxToolTimeoutMs?: number
    maxRepeatedToolErrors?: number
    nextTranscriptSequence?: () => number
}

interface OpenRouterToolExecutionCallbacks {
    onToolResult: (result: OpenRouterToolExecutionResult) => Promise<void> | void
    onUserMessage: (content: string) => Promise<void> | void
}

interface OpenRouterToolExecutionOptions {
    signal?: AbortSignal
}

interface ToolExecutionOptions {
    signal?: AbortSignal
}

type ValidToolCall = {
    toolCallId: string
    toolName: string
    rawInput: string
    toolBinding: ToolBinding
    parsedArgs: unknown
}

const DEFAULT_TOOL_TIMEOUT_MS = 120_000
const DEFAULT_MAX_REPEATED_TOOL_ERRORS = 3
const PROPOSAL_TOOL_NAMES = new Set([
    "propose_order",
    "propose_adjustment",
    "propose_close",
])

const CLOSE_TOOL_NAMES = new Set([
    "propose_close",
])

export class ToolExecutionEngine {
    private readonly repeatedToolErrors = new Map<string, number>()
    private readonly maxRepeatedToolErrors: number
    private readonly maxToolTimeoutMs: number
    private readonly opportunityCoverage: OpportunityCoverageMetrics = createOpportunityCoverageMetrics()
    private readonly degradedResearchReasons = new Set<string>()
    private degradedResearchToolFailureCount = 0
    private degradedResearchRetryCount = 0
    private fatalFault: ToolExecutionFatalFault | undefined

    constructor(private readonly config: ToolExecutionEngineConfig) {
        if (config.agentLogger && !config.nextTranscriptSequence) {
            throw new Error("ToolExecutionEngine requires nextTranscriptSequence when agentLogger is configured")
        }
        if (config.agentLogger && !config.context) {
            throw new Error("ToolExecutionEngine requires context when agentLogger is configured")
        }

        this.maxRepeatedToolErrors = config.maxRepeatedToolErrors ?? DEFAULT_MAX_REPEATED_TOOL_ERRORS
        this.maxToolTimeoutMs = config.maxToolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
    }

    async executeOpenRouterBatch(
        toolCalls: ToolCall[],
        callbacks: OpenRouterToolExecutionCallbacks,
        options: OpenRouterToolExecutionOptions = {}
    ): Promise<void> {
        const valid: ValidToolCall[] = []

        for (const toolCall of toolCalls) {
            const rawInput = toolCall.function.arguments || "{}"
            const validation = this.validateToolCall({
                toolName: toolCall.function.name,
                rawInput,
                args: rawInput,
                callId: toolCall.id,
            })

            if (validation.status === "valid") {
                valid.push({
                    toolCallId: toolCall.id,
                    toolName: toolCall.function.name,
                    rawInput,
                    toolBinding: validation.toolBinding,
                    parsedArgs: validation.parsedArgs,
                })
                continue
            }

            await callbacks.onToolResult({
                toolCallId: toolCall.id,
                toolName: toolCall.function.name,
                content: truncateToolResult(validation.content),
                rawInput,
            })

            if (validation.degradedWarning) {
                await callbacks.onUserMessage(validation.degradedWarning)
            }

            if (this.fatalFault) {
                return
            }
        }

        if (valid.length === 0 || this.fatalFault) {
            return
        }

        const executeSequentially = valid.some((entry) => requiresSerializedExecution(entry.toolBinding))
        this.config.logger.info(executeSequentially ? "Executing tools sequentially" : "Executing tools in parallel", {
            tools: valid.map((entry) => entry.toolName),
            count: valid.length,
            runId: this.config.context?.runId,
        })

        if (executeSequentially) {
            for (const entry of valid) {
                const result = await this.executeTool(entry, options.signal)
                await this.emitOpenRouterToolResult(entry, result, callbacks)

                if (this.fatalFault || options.signal?.aborted) {
                    return
                }
            }
            return
        }

        const results = await this.executeToolsInParallel(valid, options.signal)

        for (let i = 0; i < valid.length; i++) {
            await this.emitOpenRouterToolResult(valid[i]!, results[i]!, callbacks)

            if (this.fatalFault) {
                return
            }
        }
    }

    async executeMcpCall(
        toolName: string,
        args: unknown,
        callId: string,
        options: ToolExecutionOptions = {}
    ): Promise<McpToolExecutionResult> {
        const rawInput = typeof args === "string"
            ? args
            : JSON.stringify(args ?? {})
        const validation = this.validateToolCall({
            toolName,
            rawInput,
            args,
            callId,
        })

        if (validation.status !== "valid") {
            const modelContent = truncateToolResult(validation.content)
            await this.logMcpToolResult(toolName, modelContent, rawInput)
            return {
                toolName,
                content: modelContent,
                isError: true,
                fatal: Boolean(this.fatalFault),
            }
        }

        const entry: ValidToolCall = {
            toolCallId: callId,
            toolName,
            rawInput,
            toolBinding: validation.toolBinding,
            parsedArgs: validation.parsedArgs,
        }
        const result = await this.executeTool(entry, options.signal)

        const content = this.resolveExecutionResultContent(entry, result)
        const modelContent = truncateToolResult(content)
        recordOpportunityCoverage(validation.toolBinding, content, this.opportunityCoverage)
        await this.logMcpToolResult(toolName, modelContent, rawInput)

        return {
            toolName,
            content: modelContent,
            isError: result.status === "rejected" || isToolLevelErrorContent(content) || Boolean(this.fatalFault),
            fatal: Boolean(this.fatalFault),
        }
    }

    getOutcome(): ToolExecutionOutcome {
        return {
            opportunityCoverage: finalizeOpportunityCoverage(this.opportunityCoverage),
            degradedResearch: (decisionTaken) => this.buildDegradedResearch(decisionTaken),
            fatalFault: this.fatalFault,
            abortReason: this.fatalFault?.reason,
        }
    }

    hasFatalFault(): boolean {
        return Boolean(this.fatalFault)
    }

    private validateToolCall(args: {
        toolName: string
        rawInput: string
        args: unknown
        callId: string
    }): {
        status: "valid"
        toolBinding: ToolBinding
        parsedArgs: unknown
    } | {
        status: "invalid"
        content: string
        degradedWarning?: string
    } {
        const toolBinding = this.config.tools.get(args.toolName)
        if (!toolBinding) {
            const content = JSON.stringify({ error: `Unknown tool: ${args.toolName}` })
            this.config.logger.warn("Agent called unknown tool", { toolName: args.toolName })
            const degradedWarning = this.recordValidationFailureWithoutBinding(args.toolName, content, "unknown tool")
            return { status: "invalid", content, degradedWarning }
        }

        let parsedArgs: unknown
        try {
            parsedArgs = typeof args.args === "string"
                ? JSON.parse(args.args || "{}")
                : args.args ?? {}
        } catch {
            const content = JSON.stringify({ error: "Invalid JSON arguments" })
            this.config.logger.warn("Failed to parse tool arguments", {
                toolName: args.toolName,
                raw: args.rawInput,
            })
            const degradedWarning = this.recordValidationFailureWithoutBinding(args.toolName, content, "invalid arguments loop")
            return { status: "invalid", content, degradedWarning }
        }

        const validation = toolBinding.parameters.safeParse(parsedArgs)
        if (!validation.success) {
            const content = JSON.stringify({ error: "Parameter validation failed", details: validation.error })
            this.config.logger.warn("Tool parameter validation failed", {
                toolName: args.toolName,
                error: validation.error,
            })
            const degradedWarning = this.recordValidationFailureWithBinding(
                args.toolName,
                toolBinding,
                normalizeToolErrorSignature(content),
                "parameter validation loop",
                content
            )
            return { status: "invalid", content, degradedWarning }
        }

        return {
            status: "valid",
            toolBinding,
            parsedArgs: validation.data,
        }
    }

    private recordValidationFailureWithoutBinding(
        toolName: string,
        signature: string,
        repeatedReason: string,
        fatalContent = signature
    ): string | undefined {
        const repeatedError = recordRepeatedToolError(this.repeatedToolErrors, toolName, signature)
        if (repeatedError < this.maxRepeatedToolErrors) {
            return undefined
        }

        this.setFatalFault(toolName, fatalContent, `repeated identical ${toolName} tool error`)
        return undefined
    }

    private recordValidationFailureWithBinding(
        toolName: string,
        toolBinding: ToolBinding,
        signature: string,
        repeatedReason: string,
        fatalContent = signature
    ): string | undefined {
        const repeatedError = recordRepeatedToolError(this.repeatedToolErrors, toolName, signature)
        if (repeatedError < this.maxRepeatedToolErrors) {
            return undefined
        }

        if (isResearchTool(toolBinding)) {
            this.degradedResearchToolFailureCount++
            this.degradedResearchRetryCount += repeatedError
            this.degradedResearchReasons.add(`${toolName}: ${repeatedReason}`)
            clearRepeatedToolErrors(this.repeatedToolErrors, toolName)
            return `System warning: ${toolName} failed repeatedly (${repeatedReason}). Continue in degraded research mode using currently available context and prioritize bounded risk-reducing actions.`
        }

        this.setFatalFault(toolName, fatalContent, `repeated identical ${toolName} tool error`)
        return undefined
    }

    private resolveExecutionResultContent(
        entry: ValidToolCall,
        result: PromiseSettledResult<unknown>
    ): string {
        if (result.status === "fulfilled") {
            const value = result.value
            const toolLevelError = readToolLevelError(value)
            if (toolLevelError) {
                this.config.logger.error("Tool returned error result", {
                    toolName: entry.toolName,
                    error: toolLevelError,
                })
                let content = JSON.stringify(value)
                const repeatedError = recordRepeatedToolError(this.repeatedToolErrors, entry.toolName, content)

                if (repeatedError < this.maxRepeatedToolErrors) {
                    return content
                }

                if (isResearchTool(entry.toolBinding)) {
                    this.degradedResearchToolFailureCount++
                    this.degradedResearchRetryCount += repeatedError
                    this.degradedResearchReasons.add(`${entry.toolName}: tool-level error loop`)
                    clearRepeatedToolErrors(this.repeatedToolErrors, entry.toolName)
                    content = JSON.stringify({
                        warning: `Degraded research mode active: ${entry.toolName} returned repeated tool-level errors and has been bounded for this run.`,
                    })
                    return content
                }

                this.setFatalFault(entry.toolName, content, `repeated identical ${entry.toolName} tool error`)
                return content
            }

            clearRepeatedToolErrors(this.repeatedToolErrors, entry.toolName)
            return typeof value === "string" ? value : JSON.stringify(value)
        }

        const reason = result.reason
        const errorMsg = reason instanceof Error ? reason.message : String(reason)
        let content = JSON.stringify({ error: `Tool execution failed: ${errorMsg}` })
        this.config.logger.error("Tool execution error", {
            toolName: entry.toolName,
            error: errorMsg,
        })

        if (isImmediateFailClosedToolError(entry.toolBinding, errorMsg)) {
            this.setFatalFault(entry.toolName, content, `safety-critical ${entry.toolName} tool failure`)
            return content
        }

        const repeatedError = recordRepeatedToolError(this.repeatedToolErrors, entry.toolName, content)
        if (repeatedError < this.maxRepeatedToolErrors) {
            return content
        }

        if (isResearchTool(entry.toolBinding)) {
            this.degradedResearchToolFailureCount++
            this.degradedResearchRetryCount += repeatedError
            this.degradedResearchReasons.add(`${entry.toolName}: execution failure loop`)
            clearRepeatedToolErrors(this.repeatedToolErrors, entry.toolName)
            content = JSON.stringify({
                warning: `Degraded research mode active: ${entry.toolName} failed repeatedly and has been bounded for this run.`,
            })
            return content
        }

        this.setFatalFault(entry.toolName, content, `repeated identical ${entry.toolName} tool error`)
        return content
    }

    private setFatalFault(toolName: string, toolResult: string, reason: string): void {
        if (this.fatalFault) {
            return
        }

        this.fatalFault = {
            toolName,
            toolResult,
            reason,
        }
    }

    private resolveToolTimeoutMs(): number {
        const remainingMs = this.config.runTimeoutMs - (Date.now() - this.config.runStartedAt)
        if (remainingMs <= 0) {
            return 0
        }
        return Math.min(remainingMs, this.maxToolTimeoutMs)
    }

    private async executeToolsInParallel(
        valid: ValidToolCall[],
        signal?: AbortSignal
    ): Promise<PromiseSettledResult<unknown>[]> {
        return await Promise.allSettled(
            valid.map(({ toolBinding, parsedArgs }) =>
                executeToolWithTimeout(toolBinding, parsedArgs, this.resolveToolTimeoutMs(), signal)
            )
        )
    }

    private async executeTool(
        entry: ValidToolCall,
        signal?: AbortSignal
    ): Promise<PromiseSettledResult<unknown>> {
        try {
            return {
                status: "fulfilled",
                value: await executeToolWithTimeout(entry.toolBinding, entry.parsedArgs, this.resolveToolTimeoutMs(), signal),
            }
        } catch (reason) {
            return {
                status: "rejected",
                reason,
            }
        }
    }

    private async emitOpenRouterToolResult(
        entry: ValidToolCall,
        result: PromiseSettledResult<unknown>,
        callbacks: OpenRouterToolExecutionCallbacks
    ): Promise<void> {
        const content = this.resolveExecutionResultContent(entry, result)
        const modelContent = truncateToolResult(content)

        recordOpportunityCoverage(entry.toolBinding, content, this.opportunityCoverage)

        await callbacks.onToolResult({
            toolCallId: entry.toolCallId,
            toolName: entry.toolName,
            content: modelContent,
            rawInput: entry.rawInput,
        })
    }

    private async logMcpToolResult(
        toolName: string,
        content: string,
        rawInput: string
    ): Promise<void> {
        if (!this.config.agentLogger) {
            return
        }

        const nextTranscriptSequence = this.config.nextTranscriptSequence
        if (!nextTranscriptSequence) {
            throw new Error("ToolExecutionEngine requires nextTranscriptSequence when agentLogger is configured")
        }
        if (!this.config.context) {
            throw new Error("ToolExecutionEngine requires context when agentLogger is configured")
        }

        const sequence = nextTranscriptSequence()
        await safeLogAgentMessage({
            agentLogger: this.config.agentLogger,
            logger: this.config.logger,
            runId: this.config.context.runId,
            strategyId: this.config.context.strategyId,
            sequence,
            role: "tool",
            content,
            toolName,
            toolInput: rawInput,
            toolOutput: content,
        })
    }

    private buildDegradedResearch(decisionTaken: boolean): DegradedResearchOutcome {
        return {
            active: this.degradedResearchReasons.size > 0,
            reasons: Array.from(this.degradedResearchReasons),
            toolFailureCount: this.degradedResearchToolFailureCount,
            retryCount: this.degradedResearchRetryCount,
            decisionUnderDegradedContext: decisionTaken && this.degradedResearchReasons.size > 0,
        }
    }
}

async function executeToolWithTimeout(
    toolBinding: ToolBinding,
    parsedArgs: unknown,
    toolTimeoutMs: number,
    parentSignal?: AbortSignal
): Promise<unknown> {
    if (toolTimeoutMs <= 0) {
        throw new Error("Tool timed out before execution because the run timeout was exhausted")
    }

    const controller = new AbortController()
    const signal = controller.signal
    const abortFromParent = () => controller.abort(parentSignal?.reason)
    if (parentSignal) {
        assertToolNotAborted(parentSignal)
        parentSignal.addEventListener("abort", abortFromParent, { once: true })
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    try {
        return await Promise.race([
            toolBinding.handler(parsedArgs, { signal }),
            new Promise<never>((_, reject) => {
                timeoutId = setTimeout(() => {
                    timedOut = true
                    controller.abort()
                    reject(new Error(`Tool timed out after ${Math.round(toolTimeoutMs / 1000)}s`))
                }, toolTimeoutMs)
                signal.addEventListener("abort", () => {
                    if (!timedOut) {
                        reject(createAbortError("Tool execution cancelled"))
                    }
                }, { once: true })
            }),
        ])
    } finally {
        if (timeoutId) {
            clearTimeout(timeoutId)
        }
        parentSignal?.removeEventListener("abort", abortFromParent)
    }
}

function createAbortError(message: string): Error {
    const error = new Error(message)
    error.name = "AbortError"
    return error
}

function createOpportunityCoverageMetrics(): OpportunityCoverageMetrics {
    return {
        researched: 0,
        qualified: 0,
        rejectedByModel: 0,
        rejectedByRisk: 0,
        submitted: 0,
        filled: 0,
        closed: 0,
        realizedPnl: 0,
    }
}

function recordRepeatedToolError(
    repeatedToolErrors: Map<string, number>,
    toolName: string,
    errorResult: string
): number {
    const key = `${toolName}:${normalizeToolErrorSignature(errorResult)}`
    const count = (repeatedToolErrors.get(key) ?? 0) + 1
    repeatedToolErrors.set(key, count)
    return count
}

function clearRepeatedToolErrors(
    repeatedToolErrors: Map<string, number>,
    toolName: string
): void {
    for (const key of Array.from(repeatedToolErrors.keys())) {
        if (key.startsWith(`${toolName}:`)) {
            repeatedToolErrors.delete(key)
        }
    }
}

function normalizeToolErrorSignature(errorResult: string): string {
    return errorResult
        .replace(/"stack":"[^"]+"/g, "")
        .replace(/\d{4}-\d{2}-\d{2}T[^"]+/g, "timestamp")
        .slice(0, 1000)
}

function truncateToolResult(content: string): string {
    return normalizeModelToolResultContent(content)
}

function isImmediateFailClosedToolError(
    toolBinding: ToolBinding,
    errorMessage: string
): boolean {
    if (!/(credential|api key|auth|provider identity|timed out|timeout|cancelled|canceled|aborted)/i.test(errorMessage)) {
        return false
    }

    return isSafetyCriticalToolBoundary(toolBinding)
}

function requiresSerializedExecution(toolBinding: ToolBinding): boolean {
    return isSafetyCriticalToolBoundary(toolBinding)
}

function isSafetyCriticalToolBoundary(toolBinding: ToolBinding): boolean {
    return toolBinding.category === "execution" ||
        toolBinding.category === "account" ||
        toolBinding.contractBoundary === "venue-owned"
}

function isResearchTool(toolBinding: ToolBinding): boolean {
    return toolBinding.category === "research" ||
        toolBinding.category === "web" ||
        toolBinding.contractOwner?.startsWith("mcp:") === true
}

function recordOpportunityCoverage(
    toolBinding: ToolBinding,
    toolResult: string,
    metrics: OpportunityCoverageMetrics
): void {
    if (isResearchTool(toolBinding)) {
        metrics.researched++
    }

    if (!PROPOSAL_TOOL_NAMES.has(toolBinding.name)) {
        return
    }

    metrics.qualified++

    const parsed = parseToolResult(toolResult)
    if (!parsed) {
        return
    }

    const riskValidation = readRecord(parsed.riskValidation)
    if (riskValidation?.allowed === false) {
        metrics.rejectedByRisk++
    }

    const orderId = parsed.orderId
    const status = parsed.status
    if (typeof orderId === "string" && orderId.length > 0 && status !== "rejected") {
        metrics.submitted++
    }

    if (status === "filled" || status === "partially_filled") {
        metrics.filled++
        if (CLOSE_TOOL_NAMES.has(toolBinding.name)) {
            metrics.closed++
        }
    }

    const realizedPnl = readFiniteNumber(parsed.realizedPnl)
    if (realizedPnl !== undefined) {
        metrics.realizedPnl += realizedPnl
    }
}

function finalizeOpportunityCoverage(metrics: OpportunityCoverageMetrics): OpportunityCoverageMetrics {
    return {
        ...metrics,
        rejectedByModel: metrics.qualified === 0 && metrics.researched > 0 ? 1 : metrics.rejectedByModel,
    }
}

function parseToolResult(value: string): Record<string, unknown> | undefined {
    try {
        const parsed = JSON.parse(value) as unknown
        return readRecord(parsed)
    } catch {
        return undefined
    }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined
}

function readToolLevelError(value: unknown): string | undefined {
    const record = readRecord(value)
    if (record?.isError !== true) {
        return undefined
    }

    if (typeof record.error === "string" && record.error.length > 0) {
        return record.error
    }

    if (typeof record.message === "string" && record.message.length > 0) {
        return record.message
    }

    return "tool returned isError=true"
}

function isToolLevelErrorContent(content: string): boolean {
    const parsed = parseToolResult(content)
    return parsed?.isError === true
}

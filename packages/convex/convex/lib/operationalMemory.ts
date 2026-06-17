import {
    sanitizeRunSummary,
    stableJsonKey,
    type StrategyOperationalMemory,
    type StrategyOperationalMemorySeverity,
    type StrategyOperationalMemoryType,
    type VenueApp,
} from "@valiq-trading/core"

export interface OperationalMemoryToolManifestEntry {
    name: string
    schemaHash?: string
    category?: string
    contractBoundary?: string
    contractOwner?: string
}

export interface OperationalMemoryRunEvidence {
    run: {
        _id: string
        strategyId: string
        app: VenueApp
        accountId?: string
        status: "running" | "completed" | "failed"
        startedAt: number
        endedAt?: number
        summary?: string
        systemContextDigest?: {
            risk?: {
                cooldownActive?: boolean
                cooldownReason?: string
                unresolvedExecutionFaultCount?: number
                blockedInstruments?: string[]
            }
        }
        mcpToolDiagnostics?: Array<{
            providerId: string
            upstreamToolName?: string
            registeredName?: string
            reason: string
            message: string
        }>
        toolManifest?: OperationalMemoryToolManifestEntry[]
    }
    strategy: {
        _id: string
        app: VenueApp
        accountId: string
    }
    agentLogs: OperationalMemoryAgentLog[]
    now: number
}

export interface OperationalMemoryAgentLog {
    _id: string
    runId: string
    strategyId: string
    sequence: number
    role: string
    content: string
    toolName?: string
    toolInput?: string
    toolOutput?: string
    timestamp: number
}

export function buildStrategyOperationalMemoryFromRun(
    input: OperationalMemoryRunEvidence
): StrategyOperationalMemory[] {
    if (input.run.status !== "completed") {
        return []
    }

    if (input.run.strategyId !== input.strategy._id || input.run.app !== input.strategy.app) {
        return []
    }

    const manifest = new Map((input.run.toolManifest ?? []).map((entry) => [entry.name, entry]))
    const memories: StrategyOperationalMemory[] = []

    const handoff = buildRunHandoffMemory(input)
    if (handoff) {
        memories.push(handoff)
    }

    for (const log of input.agentLogs) {
        if (log.role !== "tool" || !log.toolName) {
            continue
        }

        const entry = manifest.get(log.toolName)
        const parsedOutput = parseRecord(log.toolOutput ?? log.content)
        const failure = buildToolFailureMemory(input, log, entry, parsedOutput)
        if (failure) {
            memories.push(failure)
            continue
        }

        const success = buildToolSuccessMemory(input, log, entry, parsedOutput)
        if (success) {
            memories.push(success)
        }

        const externalDiscovery = buildExternalToolMemory(input, log, entry, parsedOutput)
        if (externalDiscovery) {
            memories.push(externalDiscovery)
        }
    }

    memories.push(...buildProviderTruthMemories(input))
    memories.push(...buildRunDiagnosticMemories(input))

    return memories
}

export function isStrategyOperationalMemoryApplicable(args: {
    memory: StrategyOperationalMemory
    app: VenueApp
    accountId: string
    toolManifest: OperationalMemoryToolManifestEntry[]
    now: number
}): boolean {
    const { memory, app, accountId, now } = args
    if (memory.schemaVersion !== 1 || memory.status !== "active") {
        return false
    }
    if (memory.app !== app || memory.accountId !== accountId) {
        return false
    }
    if (memory.scope.app !== app || memory.scope.accountId !== accountId) {
        return false
    }
    if (memory.ranking.expiresAt !== undefined && memory.ranking.expiresAt <= now) {
        return false
    }

    const manifestByName = new Map(args.toolManifest.map((entry) => [entry.name, entry]))
    if (memory.scope.toolName) {
        const currentTool = manifestByName.get(memory.scope.toolName)
        if (!currentTool) {
            return false
        }
        if (memory.scope.schemaHash && currentTool.schemaHash !== memory.scope.schemaHash) {
            return false
        }
        if (memory.scope.providerId && currentTool.contractOwner !== `mcp:${memory.scope.providerId}`) {
            return false
        }
    } else if (memory.scope.providerId) {
        const providerAvailable = args.toolManifest.some((entry) =>
            entry.contractOwner === `mcp:${memory.scope.providerId}`
        )
        if (!providerAvailable) {
            return false
        }
    }

    return true
}

export function rankStrategyOperationalMemories(
    memories: StrategyOperationalMemory[]
): StrategyOperationalMemory[] {
    return [...memories].sort((left, right) => {
        const severity = severityRank(right.severity) - severityRank(left.severity)
        if (severity !== 0) {
            return severity
        }

        const score = right.ranking.score - left.ranking.score
        if (score !== 0) {
            return score
        }

        return right.updatedAt - left.updatedAt
    })
}

function buildRunHandoffMemory(input: OperationalMemoryRunEvidence): StrategyOperationalMemory | undefined {
    const summary = input.run.summary ? sanitizeRunSummary(input.run.summary).trim() : ""
    if (!summary) {
        return undefined
    }

    const endedAt = input.run.endedAt ?? input.run.startedAt
    return createMemory(input, {
        type: "run_handoff_fact",
        memoryKeyParts: ["run_handoff_fact"],
        severity: "low",
        confidence: 0.55,
        sourceTimestamp: endedAt,
        sources: [{
            runId: input.run._id,
            timestamp: endedAt,
        }],
        evidence: {
            attemptCount: 1,
            successCount: 1,
            failureCount: 0,
            sanitizedOutputDigest: hashString(truncateText(summary, 4_000)),
        },
        lesson: {
            summary: truncateText(summary, 2_000),
            useWhen: "Use only as the latest completed run handoff for continuity before re-checking current provider state.",
            avoidWhen: "Do not treat prices, news, regime analysis, positions, or intended actions as current truth.",
            providerTruth: "stale",
        },
        score: 20,
        expiresAt: input.now + 24 * 60 * 60 * 1000,
    })
}

function buildToolFailureMemory(
    input: OperationalMemoryRunEvidence,
    log: OperationalMemoryAgentLog,
    tool: OperationalMemoryToolManifestEntry | undefined,
    parsedOutput: Record<string, unknown> | undefined
): StrategyOperationalMemory | undefined {
    if (!log.toolName) {
        return undefined
    }

    const error = readToolError(parsedOutput, log.content)
    if (!error || error.kind !== "argument") {
        return undefined
    }

    const schemaHash = tool?.schemaHash
    const errorSignature = hashString(error.signature)
    const inputFingerprint = hashString(stableJsonKey(sanitizeForMemory(parseJsonValue(log.toolInput) ?? log.toolInput ?? "")))
    const requiredArgumentShape = readRequiredArgumentShape(parsedOutput)

    return createMemory(input, {
        type: "tool_argument_failure",
        memoryKeyParts: ["tool_argument_failure", log.toolName, schemaHash ?? "no-schema", errorSignature],
        severity: severityForTool(tool, "medium"),
        confidence: schemaHash ? 0.9 : 0.7,
        sourceTimestamp: log.timestamp,
        scope: {
            toolName: log.toolName,
            schemaHash,
            providerId: readProviderId(tool),
        },
        sources: [{
            runId: input.run._id,
            agentLogId: log._id,
            timestamp: log.timestamp,
        }],
        evidence: {
            attemptCount: 1,
            successCount: 0,
            failureCount: 1,
            lastErrorSignature: errorSignature,
            sanitizedInputFingerprint: inputFingerprint,
        },
        lesson: {
            summary: `Tool ${log.toolName} rejected a previous argument shape: ${truncateText(error.message, 240)}`,
            useWhen: `Before calling ${log.toolName}, validate arguments against the current tool schema.`,
            avoidWhen: "Do not retry the same argument shape if the current schema hash still matches this memory.",
            requiredArgumentShape,
            correctedExample: requiredArgumentShape,
            providerTruth: "not_verified",
        },
        score: 80,
        expiresAt: input.now + 30 * 24 * 60 * 60 * 1000,
    })
}

function buildToolSuccessMemory(
    input: OperationalMemoryRunEvidence,
    log: OperationalMemoryAgentLog,
    tool: OperationalMemoryToolManifestEntry | undefined,
    parsedOutput: Record<string, unknown> | undefined
): StrategyOperationalMemory | undefined {
    if (!log.toolName) {
        return undefined
    }

    if (readToolError(parsedOutput, log.content)) {
        return undefined
    }
    if (!tool || !isReusableToolRecipe(tool)) {
        return undefined
    }

    const sanitizedInput = sanitizeForMemory(parseJsonValue(log.toolInput) ?? {})
    const inputFingerprint = hashString(stableJsonKey(sanitizedInput))
    const outputDigest = hashString(truncateText(log.toolOutput ?? log.content, 4_000))

    return createMemory(input, {
        type: "tool_invocation_success",
        memoryKeyParts: ["tool_invocation_success", log.toolName, tool.schemaHash ?? "no-schema", inputFingerprint],
        severity: "low",
        confidence: tool.schemaHash ? 0.8 : 0.65,
        sourceTimestamp: log.timestamp,
        scope: {
            toolName: log.toolName,
            schemaHash: tool.schemaHash,
            providerId: readProviderId(tool),
        },
        sources: [{
            runId: input.run._id,
            agentLogId: log._id,
            timestamp: log.timestamp,
        }],
        evidence: {
            attemptCount: 1,
            successCount: 1,
            failureCount: 0,
            sanitizedInputFingerprint: inputFingerprint,
            sanitizedOutputDigest: outputDigest,
        },
        lesson: {
            summary: `Tool ${log.toolName} previously succeeded with this schema-compatible argument pattern.`,
            useWhen: "Reuse only when the current tool schema, strategy, account, and research need still match.",
            avoidWhen: "Do not reuse stale market data, execution prices, or provider state from the prior output.",
            correctedExample: sanitizedInput,
            providerTruth: "not_verified",
        },
        score: 45,
        expiresAt: input.now + 30 * 24 * 60 * 60 * 1000,
    })
}

function buildExternalToolMemory(
    input: OperationalMemoryRunEvidence,
    log: OperationalMemoryAgentLog,
    tool: OperationalMemoryToolManifestEntry | undefined,
    parsedOutput: Record<string, unknown> | undefined
): StrategyOperationalMemory | undefined {
    if (!log.toolName) {
        return undefined
    }

    const providerId = readProviderId(tool)
    if (!providerId || readToolError(parsedOutput, log.content)) {
        return undefined
    }

    const parsedInput = parseRecord(log.toolInput ?? "{}")
    const upstreamToolName = typeof parsedInput?.toolName === "string"
        ? parsedInput.toolName
        : undefined

    return createMemory(input, {
        type: "external_tool_discovery",
        memoryKeyParts: [
            "external_tool_discovery",
            providerId,
            log.toolName,
            upstreamToolName ?? "direct",
            tool?.schemaHash ?? "no-schema",
        ],
        severity: "low",
        confidence: tool?.schemaHash ? 0.8 : 0.65,
        sourceTimestamp: log.timestamp,
        scope: {
            providerId,
            toolName: log.toolName,
            upstreamToolName,
            schemaHash: tool?.schemaHash,
        },
        sources: [{
            runId: input.run._id,
            agentLogId: log._id,
            timestamp: log.timestamp,
        }],
        evidence: {
            attemptCount: 1,
            successCount: 1,
            failureCount: 0,
            sanitizedInputFingerprint: hashString(stableJsonKey(sanitizeForMemory(parsedInput ?? {}))),
            sanitizedOutputDigest: hashString(truncateText(log.toolOutput ?? log.content, 4_000)),
        },
        lesson: {
            summary: upstreamToolName
                ? `MCP provider ${providerId} exposed upstream tool ${upstreamToolName} through ${log.toolName}.`
                : `MCP provider ${providerId} tool ${log.toolName} was available and succeeded.`,
            useWhen: "Use only if the same registered MCP tool and schema hash are available in the current run.",
            avoidWhen: "Do not assume remote tool output or availability without calling the current registered tool.",
            providerTruth: "not_verified",
        },
        score: 50,
        expiresAt: input.now + 30 * 24 * 60 * 60 * 1000,
    })
}

function buildProviderTruthMemories(input: OperationalMemoryRunEvidence): StrategyOperationalMemory[] {
    const risk = input.run.systemContextDigest?.risk
    if (!risk) {
        return []
    }

    const memories: StrategyOperationalMemory[] = []
    const unresolvedExecutionFaultCount = risk.unresolvedExecutionFaultCount ?? 0
    if (unresolvedExecutionFaultCount > 0) {
        memories.push(createMemory(input, {
            type: "provider_truth_warning",
            memoryKeyParts: ["provider_truth_warning", "unresolved_execution_faults"],
            severity: "critical",
            confidence: 0.95,
            sourceTimestamp: input.run.endedAt ?? input.run.startedAt,
            sources: [{
                runId: input.run._id,
                timestamp: input.run.endedAt ?? input.run.startedAt,
            }],
            evidence: {
                attemptCount: 1,
                successCount: 0,
                failureCount: unresolvedExecutionFaultCount,
            },
            lesson: {
                summary: `${unresolvedExecutionFaultCount} unresolved execution fault(s) were present in the prior completed run digest.`,
                useWhen: "Before any risk-increasing action, reconcile provider truth and execution fault state.",
                avoidWhen: "Never let this advisory replace provider-sync, ownership, accounting, or order lifecycle checks.",
                providerTruth: "provider_verified",
            },
            score: 100,
            expiresAt: input.now + 7 * 24 * 60 * 60 * 1000,
        }))
    }

    if (risk.cooldownActive) {
        memories.push(createMemory(input, {
            type: "provider_truth_warning",
            memoryKeyParts: ["provider_truth_warning", "cooldown", risk.cooldownReason ?? "risk"],
            severity: "high",
            confidence: 0.9,
            sourceTimestamp: input.run.endedAt ?? input.run.startedAt,
            sources: [{
                runId: input.run._id,
                timestamp: input.run.endedAt ?? input.run.startedAt,
            }],
            evidence: {
                attemptCount: 1,
                successCount: 0,
                failureCount: 1,
            },
            lesson: {
                summary: `Prior completed run digest reported active strategy cooldown${risk.cooldownReason ? ` (${risk.cooldownReason})` : ""}.`,
                useWhen: "Check current risk state before assuming the cooldown cleared.",
                avoidWhen: "Do not use this as authority to block or allow orders; current risk checks decide.",
                providerTruth: "provider_verified",
            },
            score: 90,
            expiresAt: input.now + 7 * 24 * 60 * 60 * 1000,
        }))
    }

    return memories
}

function buildRunDiagnosticMemories(input: OperationalMemoryRunEvidence): StrategyOperationalMemory[] {
    return (input.run.mcpToolDiagnostics ?? []).map((diagnostic) => createMemory(input, {
        type: "run_diagnostic",
        memoryKeyParts: [
            "run_diagnostic",
            diagnostic.providerId,
            diagnostic.registeredName ?? diagnostic.upstreamToolName ?? "provider",
            diagnostic.reason,
        ],
        severity: diagnostic.reason === "schema_changed" ? "high" : "medium",
        confidence: 0.8,
        sourceTimestamp: input.run.endedAt ?? input.run.startedAt,
        scope: {
            providerId: diagnostic.providerId,
            toolName: diagnostic.registeredName,
            upstreamToolName: diagnostic.upstreamToolName,
        },
        sources: [{
            runId: input.run._id,
            timestamp: input.run.endedAt ?? input.run.startedAt,
        }],
        evidence: {
            attemptCount: 1,
            successCount: 0,
            failureCount: 1,
            lastErrorSignature: hashString(`${diagnostic.reason}:${diagnostic.message}`),
        },
        lesson: {
            summary: truncateText(`MCP diagnostic for ${diagnostic.providerId}: ${diagnostic.message}`, 320),
            useWhen: "Use to understand why a previously expected MCP tool may be missing or changed.",
            avoidWhen: "Do not call unavailable or schema-mismatched tools; rely on current registered tools only.",
            providerTruth: "not_verified",
        },
        score: diagnostic.reason === "schema_changed" ? 75 : 55,
        expiresAt: input.now + 7 * 24 * 60 * 60 * 1000,
    }))
}

function createMemory(
    input: OperationalMemoryRunEvidence,
    args: {
        type: StrategyOperationalMemoryType
        memoryKeyParts: string[]
        severity: StrategyOperationalMemorySeverity
        confidence: number
        sourceTimestamp: number
        scope?: Partial<StrategyOperationalMemory["scope"]>
        sources: StrategyOperationalMemory["sources"]
        evidence: StrategyOperationalMemory["evidence"]
        lesson: StrategyOperationalMemory["lesson"]
        score: number
        expiresAt: number
    }
): StrategyOperationalMemory {
    const scope = {
        app: input.strategy.app,
        accountId: input.strategy.accountId,
        ...args.scope,
    }
    const key = buildMemoryKey([
        1,
        input.strategy._id,
        input.strategy.app,
        input.strategy.accountId,
        ...args.memoryKeyParts,
    ])

    return {
        schemaVersion: 1,
        memoryKey: key,
        strategyId: input.strategy._id,
        app: input.strategy.app,
        accountId: input.strategy.accountId,
        type: args.type,
        status: "active",
        severity: args.severity,
        confidence: args.confidence,
        scope,
        sources: args.sources,
        evidence: args.evidence,
        lesson: args.lesson,
        ranking: {
            score: args.score,
            expiresAt: args.expiresAt,
        },
        createdAt: input.now,
        updatedAt: input.now,
    }
}

function readToolError(
    parsedOutput: Record<string, unknown> | undefined,
    content: string
): { kind: "argument" | "tool"; message: string; signature: string } | undefined {
    const errorValue = typeof parsedOutput?.error === "string"
        ? parsedOutput.error
        : typeof parsedOutput?.message === "string"
            ? parsedOutput.message
            : undefined
    const text = errorValue ?? content
    if (!text) {
        return undefined
    }

    if (
        text.includes("Parameter validation failed") ||
        text.includes("Invalid JSON arguments") ||
        text.includes("Unknown tool")
    ) {
        return {
            kind: "argument",
            message: text,
            signature: truncateText(stableJsonKey(sanitizeForMemory(parsedOutput ?? text)), 2_000),
        }
    }

    if (parsedOutput?.isError === true || typeof parsedOutput?.error === "string") {
        return {
            kind: "tool",
            message: text,
            signature: truncateText(stableJsonKey(sanitizeForMemory(parsedOutput ?? text)), 2_000),
        }
    }

    return undefined
}

function readRequiredArgumentShape(parsedOutput: Record<string, unknown> | undefined): unknown {
    const details = readRecord(parsedOutput?.details)
    const issues = Array.isArray(details?.issues)
        ? details.issues
        : readIssuesFromMessage(details?.message)

    if (!issues || issues.length === 0) {
        return undefined
    }

    return {
        requiredFields: issues
            .map((issue) => readIssuePath(issue))
            .filter((path): path is string => Boolean(path)),
        issues: issues.slice(0, 8).map((issue) => ({
            path: readIssuePath(issue),
            code: readStringField(issue, "code"),
            expected: readStringField(issue, "expected"),
            message: readStringField(issue, "message"),
        })),
    }
}

function readIssuesFromMessage(value: unknown): unknown[] | undefined {
    if (typeof value !== "string") {
        return undefined
    }
    try {
        const parsed = JSON.parse(value) as unknown
        return Array.isArray(parsed) ? parsed : undefined
    } catch {
        return undefined
    }
}

function readIssuePath(value: unknown): string | undefined {
    const record = readRecord(value)
    const path = record?.path
    if (!Array.isArray(path)) {
        return undefined
    }

    return path.map((entry) => String(entry)).join(".")
}

function readStringField(value: unknown, field: string): string | undefined {
    const record = readRecord(value)
    const entry = record?.[field]
    return typeof entry === "string" ? entry : undefined
}

function isReusableToolRecipe(tool: OperationalMemoryToolManifestEntry): boolean {
    return tool.contractOwner?.startsWith("mcp:") === true ||
        tool.category === "research" ||
        tool.category === "web" ||
        tool.category === "market-data"
}

function severityForTool(
    tool: OperationalMemoryToolManifestEntry | undefined,
    fallback: StrategyOperationalMemorySeverity
): StrategyOperationalMemorySeverity {
    if (tool?.category === "execution" || tool?.category === "account" || tool?.contractBoundary === "venue-owned") {
        return "high"
    }

    return fallback
}

function readProviderId(tool: OperationalMemoryToolManifestEntry | undefined): string | undefined {
    return tool?.contractOwner?.startsWith("mcp:")
        ? tool.contractOwner.slice("mcp:".length)
        : undefined
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
    return readRecord(parseJsonValue(value))
}

function parseJsonValue(value: unknown): unknown {
    if (typeof value !== "string") {
        return value
    }

    try {
        return JSON.parse(value) as unknown
    } catch {
        return undefined
    }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined
}

function sanitizeForMemory(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.slice(0, 20).map((entry) => sanitizeForMemory(entry))
    }

    if (!value || typeof value !== "object") {
        return typeof value === "string" ? truncateText(value, 500) : value
    }

    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
        result[key] = isSensitiveKey(key)
            ? "[redacted]"
            : sanitizeForMemory(entry)
    }

    return result
}

function isSensitiveKey(key: string): boolean {
    return /(secret|password|credential|api[_-]?key|auth|bearer)/i.test(key)
}

function truncateText(value: string, maxLength: number): string {
    return value.length > maxLength
        ? `${value.slice(0, maxLength)} [truncated]`
        : value
}

function buildMemoryKey(parts: Array<string | number | undefined>): string {
    return parts
        .filter((part): part is string | number => part !== undefined)
        .map((part) => String(part).replace(/\s+/g, " ").trim())
        .join("|")
}

function hashString(value: string): string {
    let hash = 0x811c9dc5
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193)
    }

    return (hash >>> 0).toString(16).padStart(8, "0")
}

function severityRank(severity: StrategyOperationalMemorySeverity): number {
    if (severity === "critical") {
        return 4
    }
    if (severity === "high") {
        return 3
    }
    if (severity === "medium") {
        return 2
    }

    return 1
}

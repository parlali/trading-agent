import {
    buildDryRunAccountState,
    isDryRunAccountLedgerPosition,
    readFiniteNumber,
    resolveStrategyLlmConfig,
    type AccountState,
    type App,
    type Position,
} from "@valiq-trading/core"
import { listToolContracts } from "@valiq-trading/agent/src/tool-contracts.ts"
import type {
    AgentLogRow,
    PortfolioFreshnessRow,
    StoredRun,
    StoredStrategy,
    TradeEventRow,
} from "@valiq-trading/convex"
import { listSchedulerExtraToolNames } from "../../src/scheduler-tool-catalog"

export interface CodexRunAuditInput {
    exportedAt: string
    strategy: StoredStrategy
    run: StoredRun
    agentLogs: AgentLogRow[]
    tradeEvents: TradeEventRow[]
    positions: Position[]
    portfolioFreshness: PortfolioFreshnessRow[]
}

export interface CodexRunAuditArtifact {
    exportedAt: string
    strategy: {
        id: string
        name: string
        app: App
        dryRun: boolean
        llmProvider: string
        llmModel: string
        llmAuthMode?: string
    }
    run: {
        id: string
        status: StoredRun["status"]
        trigger?: StoredRun["trigger"]
        startedAt: number
        endedAt?: number
        summary?: string
        error?: string
        llmProvider?: StoredRun["llmProvider"]
        llmModel?: string
        llmAuthMode?: string
        llmBillingMode?: string
        codexThreadId?: string
        codexTurnIds?: string[]
        hasRateLimitBefore: boolean
        hasRateLimitAfter: boolean
    }
    evidence: {
        toolLogCount: number
        toolNames: string[]
        nonCanonicalToolNames: string[]
        tradeEventCount: number
        dryRunPositionCount: number
        hasDryRunLedger: boolean
        dryRunLedgerSourceRunId?: string
        providerSync?: {
            app: App
            lastSyncedAt?: number
            lastVerifiedAt?: number
            providerStatus: string
            stale: boolean
            driftDetected: boolean
            lastError?: string
            lastDriftSummary?: string
        }
        providerSyncAudit: {
            referenceTimestamp: number
            syncedAfterRun: boolean
            verifiedAfterRun: boolean
            mismatches: string[]
        }
        dryRunAccounting: {
            ledger?: {
                cashAdjustment?: number
                realizedPnl?: number
                balance?: number
                equity?: number
                openPnl?: number
                dayPnl?: number
            }
            recomputed?: {
                cashAdjustment: number
                realizedPnl: number
                balance: number
                equity: number
                openPnl: number
                dayPnl: number
            }
            mismatches: string[]
        }
        evidenceLinkage: {
            mismatches: string[]
        }
    }
    gates: {
        providerIdentityIsCodex: boolean
        evidenceRowsMatchRun: boolean
        dryRunStrategy: boolean
        completedRun: boolean
        toolLogsFromSharedEngine: boolean
        noForbiddenToolRan: boolean
        canonicalRunToolsOnly: boolean
        dryRunAccountingMatchesRun: boolean
        providerSyncHealthy: boolean
    }
    failures: string[]
}

const FORBIDDEN_CODEX_TOOL_NAMES = new Set([
    "apply_patch",
    "browser",
    "exec",
    "exec_command",
    "file_edit",
    "file_write",
    "shell",
    "unified_exec",
    "web_fetch",
    "web_search",
])

const CANONICAL_RUN_TOOL_NAMES = new Set([
    ...listToolContracts().map((contract) => contract.name),
    ...listSchedulerExtraToolNames(),
])

export function buildCodexRunAuditArtifact(input: CodexRunAuditInput): CodexRunAuditArtifact {
    const llm = resolveStrategyLlmConfig(input.strategy.policy)
    const toolLogs = input.agentLogs.filter((log) => log.role === "tool")
    const toolNames = Array.from(
        new Set(toolLogs.map((log) => log.toolName).filter((toolName): toolName is string => Boolean(toolName)))
    ).sort((left, right) => left.localeCompare(right))
    const forbiddenToolNames = toolNames.filter((toolName) => FORBIDDEN_CODEX_TOOL_NAMES.has(toolName))
    const nonCanonicalToolNames = toolNames.filter((toolName) => !CANONICAL_RUN_TOOL_NAMES.has(toolName))
    const ledger = input.positions.find((position) => isDryRunAccountLedgerPosition(position))
    const dryRunPositions = input.positions.filter((position) => !isDryRunAccountLedgerPosition(position))
    const providerSync = input.portfolioFreshness.find((row) => row.app === input.run.app)
    const dryRunAccounting = buildDryRunAccountingAudit({
        policy: input.strategy.policy,
        ledger,
        positions: dryRunPositions,
    })
    const evidenceLinkage = buildEvidenceLinkageAudit(input)
    const providerSyncAudit = buildProviderSyncAudit({
        providerSync,
        run: input.run,
    })
    const toolLogsFromSharedEngine = toolLogs.length > 0 && toolLogs.every((log) =>
        typeof log.toolName === "string" &&
        typeof log.toolInput === "string" &&
        typeof log.toolOutput === "string"
    )
    const dryRunLedgerSourceRunId = typeof ledger?.metadata?.sourceRunId === "string"
        ? ledger.metadata.sourceRunId
        : undefined
    const gates = {
        providerIdentityIsCodex: input.run.llmProvider === "codex" && llm.provider === "codex",
        evidenceRowsMatchRun: evidenceLinkage.mismatches.length === 0,
        dryRunStrategy: input.strategy.policy.dryRun === true,
        completedRun: input.run.status === "completed" && input.run.error === undefined,
        toolLogsFromSharedEngine,
        noForbiddenToolRan: forbiddenToolNames.length === 0,
        canonicalRunToolsOnly: nonCanonicalToolNames.length === 0,
        dryRunAccountingMatchesRun: Boolean(ledger) &&
            dryRunLedgerSourceRunId === String(input.run._id) &&
            dryRunAccounting.mismatches.length === 0,
        providerSyncHealthy: providerSyncAudit.mismatches.length === 0,
    }
    const failures = buildFailures({
        gates,
        input,
        llm,
        toolLogs,
        forbiddenToolNames,
        nonCanonicalToolNames,
        ledger,
        dryRunAccounting,
        evidenceLinkage,
        providerSyncAudit,
        providerSync,
    })

    return {
        exportedAt: input.exportedAt,
        strategy: {
            id: String(input.strategy._id),
            name: input.strategy.name,
            app: input.strategy.app,
            dryRun: input.strategy.policy.dryRun === true,
            llmProvider: llm.provider,
            llmModel: llm.model,
            llmAuthMode: llm.provider === "codex" ? llm.authMode : undefined,
        },
        run: {
            id: String(input.run._id),
            status: input.run.status,
            trigger: input.run.trigger,
            startedAt: input.run.startedAt,
            endedAt: input.run.endedAt,
            summary: input.run.summary,
            error: input.run.error,
            llmProvider: input.run.llmProvider,
            llmModel: input.run.llmModel,
            llmAuthMode: input.run.llmAuthMode,
            llmBillingMode: input.run.llmBillingMode,
            codexThreadId: input.run.codexThreadId,
            codexTurnIds: input.run.codexTurnIds,
            hasRateLimitBefore: input.run.llmRateLimitSnapshotBefore !== undefined,
            hasRateLimitAfter: input.run.llmRateLimitSnapshotAfter !== undefined,
        },
        evidence: {
            toolLogCount: toolLogs.length,
            toolNames,
            nonCanonicalToolNames,
            tradeEventCount: input.tradeEvents.length,
            dryRunPositionCount: dryRunPositions.length,
            hasDryRunLedger: Boolean(ledger),
            dryRunLedgerSourceRunId,
            providerSync: providerSync
                ? {
                    app: providerSync.app,
                    lastSyncedAt: providerSync.lastSyncedAt,
                    lastVerifiedAt: providerSync.lastVerifiedAt,
                    providerStatus: providerSync.providerStatus,
                    stale: providerSync.stale,
                    driftDetected: providerSync.driftDetected,
                    lastError: providerSync.lastError,
                    lastDriftSummary: providerSync.lastDriftSummary,
                }
                : undefined,
            providerSyncAudit,
            dryRunAccounting,
            evidenceLinkage,
        },
        gates,
        failures,
    }
}

function buildFailures(args: {
    gates: CodexRunAuditArtifact["gates"]
    input: CodexRunAuditInput
    llm: ReturnType<typeof resolveStrategyLlmConfig>
    toolLogs: AgentLogRow[]
    forbiddenToolNames: string[]
    nonCanonicalToolNames: string[]
    ledger: Position | undefined
    dryRunAccounting: CodexRunAuditArtifact["evidence"]["dryRunAccounting"]
    evidenceLinkage: CodexRunAuditArtifact["evidence"]["evidenceLinkage"]
    providerSyncAudit: CodexRunAuditArtifact["evidence"]["providerSyncAudit"]
    providerSync: PortfolioFreshnessRow | undefined
}): string[] {
    const failures: string[] = []

    if (!args.gates.providerIdentityIsCodex) {
        failures.push(`Expected Codex provider identity, got strategy=${args.llm.provider}, run=${args.input.run.llmProvider ?? "missing"}`)
    }
    if (!args.gates.evidenceRowsMatchRun) {
        failures.push(...args.evidenceLinkage.mismatches.map((mismatch) => `Audit evidence linkage failed: ${mismatch}`))
    }
    if (args.input.run.llmModel !== args.llm.model) {
        failures.push(`Run model ${args.input.run.llmModel ?? "missing"} does not match strategy model ${args.llm.model}`)
    }
    if (args.llm.provider === "codex" && args.input.run.llmAuthMode !== args.llm.authMode) {
        failures.push(`Run auth mode ${args.input.run.llmAuthMode ?? "missing"} does not match strategy auth mode ${args.llm.authMode}`)
    }
    if (!args.input.run.codexThreadId) {
        failures.push("Codex thread id is missing")
    }
    if ((args.input.run.codexTurnIds ?? []).length === 0) {
        failures.push("Codex turn ids are missing")
    }
    if (args.input.run.llmRateLimitSnapshotBefore === undefined || args.input.run.llmRateLimitSnapshotAfter === undefined) {
        failures.push("Codex rate limit snapshots are incomplete")
    }
    if (!args.gates.dryRunStrategy) {
        failures.push("Strategy is not configured as dry-run")
    }
    if (!args.gates.completedRun) {
        failures.push(`Run did not complete cleanly: status=${args.input.run.status}, error=${args.input.run.error ?? "none"}`)
    }
    if (!args.gates.toolLogsFromSharedEngine) {
        failures.push(`Tool logs are missing or incomplete for shared-engine proof: count=${args.toolLogs.length}`)
    }
    if (!args.gates.noForbiddenToolRan) {
        failures.push(`Forbidden Codex tool names appeared in agent logs: ${args.forbiddenToolNames.join(", ")}`)
    }
    if (!args.gates.canonicalRunToolsOnly) {
        failures.push(`Non-canonical Codex tool names appeared in agent logs: ${args.nonCanonicalToolNames.join(", ")}`)
    }
    if (!args.gates.dryRunAccountingMatchesRun) {
        const sourceRunId = typeof args.ledger?.metadata?.sourceRunId === "string"
            ? args.ledger.metadata.sourceRunId
            : "missing"
        failures.push(`Dry-run ledger does not prove this run: ledger=${args.ledger ? "present" : "missing"}, sourceRunId=${sourceRunId}`)
        failures.push(...args.dryRunAccounting.mismatches.map((mismatch) => `Dry-run accounting mismatch: ${mismatch}`))
    }
    if (!args.gates.providerSyncHealthy) {
        failures.push(...args.providerSyncAudit.mismatches.map((mismatch) => `Provider-sync gate failed: ${mismatch}`))
    }

    return failures
}

function buildProviderSyncAudit(args: {
    providerSync: PortfolioFreshnessRow | undefined
    run: StoredRun
}): CodexRunAuditArtifact["evidence"]["providerSyncAudit"] {
    const referenceTimestamp = args.run.endedAt ?? args.run.startedAt
    const syncedAfterRun = typeof args.providerSync?.lastSyncedAt === "number" &&
        args.providerSync.lastSyncedAt >= referenceTimestamp
    const verifiedAfterRun = typeof args.providerSync?.lastVerifiedAt === "number" &&
        args.providerSync.lastVerifiedAt >= referenceTimestamp
    const mismatches: string[] = []

    if (!args.providerSync) {
        mismatches.push("provider-sync state is missing")
    } else {
        if (args.providerSync.providerStatus !== "healthy") {
            mismatches.push(`provider status is ${args.providerSync.providerStatus}`)
        }
        if (args.providerSync.stale) {
            mismatches.push("provider-sync state is stale")
        }
        if (args.providerSync.driftDetected) {
            mismatches.push(`provider-sync drift is detected${args.providerSync.lastDriftSummary ? `: ${args.providerSync.lastDriftSummary}` : ""}`)
        }
        if (args.providerSync.lastError) {
            mismatches.push(`provider-sync lastError is set: ${args.providerSync.lastError}`)
        }
        if (!syncedAfterRun) {
            mismatches.push(`provider-sync lastSyncedAt ${args.providerSync.lastSyncedAt ?? "missing"} is before run reference ${referenceTimestamp}`)
        }
        if (!verifiedAfterRun) {
            mismatches.push(`provider-sync lastVerifiedAt ${args.providerSync.lastVerifiedAt ?? "missing"} is before run reference ${referenceTimestamp}`)
        }
    }

    return {
        referenceTimestamp,
        syncedAfterRun,
        verifiedAfterRun,
        mismatches,
    }
}

function buildEvidenceLinkageAudit(input: CodexRunAuditInput): CodexRunAuditArtifact["evidence"]["evidenceLinkage"] {
    return {
        mismatches: [
            ...buildRunLinkageFailures(input),
            ...input.agentLogs.flatMap((log) => buildAgentLogLinkageFailures(input, log)),
            ...input.tradeEvents.flatMap((event) => buildTradeEventLinkageFailures(input, event)),
        ],
    }
}

function buildRunLinkageFailures(input: CodexRunAuditInput): string[] {
    const mismatches: string[] = []
    const strategyId = String(input.strategy._id)

    if (String(input.run.strategyId) !== strategyId) {
        mismatches.push(`run strategyId ${input.run.strategyId} does not match strategy ${strategyId}`)
    }
    if (input.run.app !== input.strategy.app) {
        mismatches.push(`run app ${input.run.app} does not match strategy app ${input.strategy.app}`)
    }

    return mismatches
}

function buildAgentLogLinkageFailures(input: CodexRunAuditInput, log: AgentLogRow): string[] {
    const mismatches: string[] = []
    const runId = String(input.run._id)
    const strategyId = String(input.strategy._id)

    if (String(log.runId) !== runId) {
        mismatches.push(`agent log ${log._id} runId ${log.runId} does not match run ${runId}`)
    }
    if (String(log.strategyId) !== strategyId) {
        mismatches.push(`agent log ${log._id} strategyId ${log.strategyId} does not match strategy ${strategyId}`)
    }

    return mismatches
}

function buildTradeEventLinkageFailures(input: CodexRunAuditInput, event: TradeEventRow): string[] {
    const mismatches: string[] = []
    const runId = String(input.run._id)
    const strategyId = String(input.strategy._id)

    if (String(event.runId) !== runId) {
        mismatches.push(`trade event ${event._id} runId ${event.runId} does not match run ${runId}`)
    }
    if (String(event.strategyId) !== strategyId) {
        mismatches.push(`trade event ${event._id} strategyId ${event.strategyId} does not match strategy ${strategyId}`)
    }
    if (event.app && event.app !== input.run.app) {
        mismatches.push(`trade event ${event._id} app ${event.app} does not match run app ${input.run.app}`)
    }

    return mismatches
}

function buildDryRunAccountingAudit(args: {
    policy: Record<string, unknown>
    ledger: Position | undefined
    positions: Position[]
}): CodexRunAuditArtifact["evidence"]["dryRunAccounting"] {
    if (!args.ledger) {
        return {
            mismatches: ["ledger position is missing"],
        }
    }

    const ledgerValues = {
        cashAdjustment: readFiniteNumber(args.ledger.metadata?.cashAdjustment),
        realizedPnl: readFiniteNumber(args.ledger.metadata?.realizedPnl),
        balance: readFiniteNumber(args.ledger.metadata?.balance),
        equity: readFiniteNumber(args.ledger.metadata?.equity),
        openPnl: readFiniteNumber(args.ledger.metadata?.openPnl),
        dayPnl: readFiniteNumber(args.ledger.metadata?.dayPnl),
    }
    const missingFields = Object.entries(ledgerValues)
        .filter(([, value]) => value === undefined)
        .map(([field]) => field)
    const cashAdjustment = ledgerValues.cashAdjustment ?? 0
    const realizedPnl = ledgerValues.realizedPnl ?? 0
    const recomputedState = buildDryRunAccountState({
        policy: args.policy,
        positions: args.positions,
        cashAdjustment,
        realizedPnl,
    })
    const mismatches = [
        ...missingFields.map((field) => `ledger metadata ${field} is missing or non-finite`),
        ...compareLedgerField("balance", ledgerValues.balance, recomputedState.balance),
        ...compareLedgerField("equity", ledgerValues.equity, recomputedState.equity),
        ...compareLedgerField("openPnl", ledgerValues.openPnl, recomputedState.openPnl),
        ...compareLedgerField("dayPnl", ledgerValues.dayPnl, recomputedState.dayPnl),
    ]

    return {
        ledger: buildLedgerEvidence(ledgerValues),
        recomputed: {
            cashAdjustment,
            realizedPnl,
            balance: recomputedState.balance,
            equity: recomputedState.equity,
            openPnl: recomputedState.openPnl,
            dayPnl: recomputedState.dayPnl,
        },
        mismatches,
    }
}

function buildLedgerEvidence(values: {
    cashAdjustment: number | undefined
    realizedPnl: number | undefined
    balance: number | undefined
    equity: number | undefined
    openPnl: number | undefined
    dayPnl: number | undefined
}): CodexRunAuditArtifact["evidence"]["dryRunAccounting"]["ledger"] {
    const evidence: NonNullable<CodexRunAuditArtifact["evidence"]["dryRunAccounting"]["ledger"]> = {}

    for (const [key, value] of Object.entries(values) as Array<[keyof typeof values, number | undefined]>) {
        if (value !== undefined) {
            evidence[key] = value
        }
    }

    return evidence
}

function compareLedgerField(
    field: keyof Pick<AccountState, "balance" | "equity" | "openPnl" | "dayPnl">,
    ledgerValue: number | undefined,
    expectedValue: number
): string[] {
    if (ledgerValue === undefined) {
        return []
    }

    return Math.abs(ledgerValue - expectedValue) <= 0.00000001
        ? []
        : [`ledger metadata ${field}=${ledgerValue} does not match recomputed ${field}=${expectedValue}`]
}

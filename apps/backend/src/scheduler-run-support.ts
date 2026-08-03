import type { RunDiagnostics, RunOrderRow } from "@valiq-trading/convex"
import {
    parseDecisionRecordOutput,
    type AgentRunResult,
} from "@valiq-trading/agent"
import {
    createKillSwitchGuardedVenue as createRuntimeKillSwitchGuardedVenue,
    isDecisionRecordPolicyEnabled,
    readConfiguredStrategySafetyPolicy,
    resolveDryRunAccountState,
    resolveRuntimeStrategySafetyPolicy,
    type AccountState,
    type DecisionRecord,
    type Position,
    type RunSystemContextDigest,
    type StrategyRiskState,
    type VenueAdapter,
} from "@valiq-trading/core"
import type { VenueApp } from "./types"
import { killSwitchCheckers } from "./state"

export const PRE_RUN_HOOK_TIMEOUT_MS = 90_000
export const POST_RUN_HOOK_TIMEOUT_MS = 90_000
export const STRATEGY_RUN_TIMEOUT_MS = 12 * 60 * 1000

export async function checkKillSwitch(app: VenueApp, context: string): Promise<boolean> {
    const checker = killSwitchCheckers[app]
    if (!checker) return false
    return await checker(context)
}

export function createKillSwitchGuardedVenue(
    venue: VenueAdapter,
    app: VenueApp,
    strategyId: string
): VenueAdapter {
    const checker = killSwitchCheckers[app]
    if (!checker) return venue
    return createRuntimeKillSwitchGuardedVenue(
        venue,
        strategyId,
        checker
    )
}

export function mergePendingOrderBlockedInstrumentsIntoRiskState(
    riskState: StrategyRiskState,
    blockedInstruments: string[]
): StrategyRiskState {
    if (blockedInstruments.length === 0) {
        return riskState
    }

    const existingBlocked = new Set(riskState.blockedInstruments)
    const mergedBlockedInstruments = Array.from(
        new Set([...riskState.blockedInstruments, ...blockedInstruments])
    ).sort((left, right) => left.localeCompare(right))
    const newBlockedCount = blockedInstruments.filter((instrument) => !existingBlocked.has(instrument)).length

    return {
        ...riskState,
        safetyState: riskState.safetyState === "healthy"
            ? "execution_degraded"
            : riskState.safetyState,
        blockedInstruments: mergedBlockedInstruments,
        unresolvedExecutionFaultCount: riskState.unresolvedExecutionFaultCount + newBlockedCount,
    }
}

export function buildRunDiagnostics(result: {
    usage: {
        promptTokens: number
        completionTokens: number
        reasoningTokens: number
        cost: number
        responseIds: string[]
    }
    providerDiagnostics?: {
        provider: "openrouter" | "codex"
        model: string
        authMode?: string
        billingMode?: string
        responseIds: string[]
        codexThreadId?: string
        codexTurnIds?: string[]
        rateLimitSnapshotBefore?: unknown
        rateLimitSnapshotAfter?: unknown
    }
    opportunityCoverage: {
        researched: number
        qualified: number
        rejectedByModel: number
        rejectedByRisk: number
    }
    degradedResearch?: {
        active: boolean
        reasons: string[]
        toolFailureCount: number
        retryCount: number
        decisionUnderDegradedContext: boolean
    }
} & Pick<AgentRunResult, "toolCallCount" | "toolManifest">, systemContextDigest?: RunSystemContextDigest): RunDiagnostics | undefined {
    const diagnostics: RunDiagnostics = {}

    diagnostics.promptTokens = result.usage.promptTokens
    diagnostics.completionTokens = result.usage.completionTokens
    diagnostics.reasoningTokens = result.usage.reasoningTokens
    diagnostics.llmCost = result.usage.cost
    if (result.providerDiagnostics) {
        diagnostics.llmProvider = result.providerDiagnostics.provider
        diagnostics.llmModel = result.providerDiagnostics.model
        diagnostics.llmResponseIds = result.providerDiagnostics.responseIds
        if (result.providerDiagnostics.authMode !== undefined) diagnostics.llmAuthMode = result.providerDiagnostics.authMode
        if (result.providerDiagnostics.billingMode !== undefined) diagnostics.llmBillingMode = result.providerDiagnostics.billingMode
        if (result.providerDiagnostics.codexThreadId !== undefined) diagnostics.codexThreadId = result.providerDiagnostics.codexThreadId
        if (result.providerDiagnostics.codexTurnIds !== undefined) diagnostics.codexTurnIds = result.providerDiagnostics.codexTurnIds
        if (result.providerDiagnostics.rateLimitSnapshotBefore !== undefined) {
            diagnostics.llmRateLimitSnapshotBefore = result.providerDiagnostics.rateLimitSnapshotBefore
        }
        if (result.providerDiagnostics.rateLimitSnapshotAfter !== undefined) {
            diagnostics.llmRateLimitSnapshotAfter = result.providerDiagnostics.rateLimitSnapshotAfter
        }
    }
    if (result.providerDiagnostics?.provider === "openrouter" || !result.providerDiagnostics) {
        diagnostics.openRouterResponseIds = result.providerDiagnostics?.responseIds ?? result.usage.responseIds
    }
    diagnostics.opportunityResearched = result.opportunityCoverage.researched
    diagnostics.opportunityQualified = result.opportunityCoverage.qualified
    diagnostics.opportunityRejectedByModel = result.opportunityCoverage.rejectedByModel
    diagnostics.opportunityRejectedByRisk = result.opportunityCoverage.rejectedByRisk
    diagnostics.toolCallCount = result.toolCallCount

    if (result.degradedResearch) {
        diagnostics.degradedResearch = result.degradedResearch.active
        diagnostics.degradedReason = result.degradedResearch.reasons.join("; ")
        diagnostics.toolFailureCount = result.degradedResearch.toolFailureCount
        diagnostics.toolRetryCount = result.degradedResearch.retryCount
        diagnostics.decisionUnderDegradedContext = result.degradedResearch.decisionUnderDegradedContext
    }

    if (systemContextDigest) {
        diagnostics.systemContextDigest = systemContextDigest
    }
    diagnostics.toolManifest = result.toolManifest

    return Object.keys(diagnostics).length > 0
        ? diagnostics
        : undefined
}

export function buildRunDecisionRecord(
    policy: Record<string, unknown>,
    summary: string | undefined,
    transcriptMessages: AgentRunTranscriptMessage[] = [],
    derivationSource?: RunDecisionDerivationSource
): DecisionRecord | undefined {
    if (!isDecisionRecordPolicyEnabled(policy)) {
        return undefined
    }

    const decisionRecord = parseDecisionRecordOutput(buildDecisionRecordParserInput(summary, transcriptMessages))
    const effectiveDecision = deriveEffectiveDecision(decisionRecord, derivationSource)

    return effectiveDecision === undefined
        ? decisionRecord
        : {
            ...decisionRecord,
            effectiveDecision,
        }
}

export interface AgentRunTranscriptMessage {
    sequence: number
    role: string
    content: string
}

export interface RunDecisionDerivationSource {
    canonicalOrders?: readonly RunDecisionCanonicalOrder[]
    validationRejectedCount?: number
}

export type RunDecisionCanonicalOrder = Pick<RunOrderRow, "action" | "status" | "filledQuantity">

export function deriveEffectiveDecision(
    decisionRecord: DecisionRecord,
    source: RunDecisionDerivationSource = {}
): DecisionRecord["effectiveDecision"] | undefined {
    if (decisionRecord.decision === undefined || source.canonicalOrders === undefined) {
        return undefined
    }

    if (source.canonicalOrders.some(isAcceptedEntryOrCloseOrder)) {
        return "trade"
    }

    if (decisionRecord.decision === "trade" && readNonNegativeCount(source.validationRejectedCount) > 0) {
        return "trade_blocked"
    }

    if (source.canonicalOrders.some(isManageOnlyOrder) || decisionRecord.decision === "manage_only") {
        return "manage_only"
    }

    if (decisionRecord.decision === "no_trade") {
        return "no_trade"
    }

    return undefined
}

function isAcceptedEntryOrCloseOrder(order: RunDecisionCanonicalOrder): boolean {
    return order.action === "entry" || order.action === "close"
}

function isManageOnlyOrder(order: RunDecisionCanonicalOrder): boolean {
    return order.action === "adjustment" || order.action === "modify" || order.action === "cancel"
}

function readNonNegativeCount(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0
        ? value
        : 0
}

function buildDecisionRecordParserInput(
    summary: string | undefined,
    transcriptMessages: AgentRunTranscriptMessage[]
): string {
    const assistantMessages = transcriptMessages
        .filter((message) => message.role === "assistant" && message.content.length > 0)
        .sort((left, right) => left.sequence - right.sequence)
        .map((message) => message.content)

    if (summary !== undefined && summary.length > 0) {
        assistantMessages.push(summary)
    }

    return assistantMessages.join("\n\n")
}

export async function resolveRuntimeSafetyPolicyForRun(args: {
    policy: Record<string, unknown>
    venue: VenueAdapter
    latestStoredPositions?: Position[]
    accountState?: AccountState
}): Promise<ReturnType<typeof resolveRuntimeStrategySafetyPolicy>> {
    const configuredSafety = readConfiguredStrategySafetyPolicy(args.policy)
    const requiresBalance = configuredSafety.maxDrawdownDay !== undefined ||
        configuredSafety.maxDrawdownWeek !== undefined

    if (!requiresBalance) {
        return resolveRuntimeStrategySafetyPolicy({
            policy: configuredSafety,
        })
    }

    if (args.accountState) {
        return resolveRuntimeStrategySafetyPolicy({
            policy: configuredSafety,
            accountBalance: args.accountState.balance,
        })
    }

    if (Boolean(args.policy.dryRun)) {
        if (args.latestStoredPositions === undefined) {
            throw new Error("Dry-run safety policy resolution requires stored positions or current account state")
        }

        const dryRunAccountState = resolveDryRunAccountState({
            policy: args.policy,
            positions: args.latestStoredPositions,
        })

        return resolveRuntimeStrategySafetyPolicy({
            policy: configuredSafety,
            accountBalance: dryRunAccountState.balance,
        })
    }

    throw new Error("Live safety policy resolution requires strategy-scoped account state")
}

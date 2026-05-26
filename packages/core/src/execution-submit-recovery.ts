import type { ExecutionResult, OrderIntent } from "./types"
import type {
    SubmitOrderContext,
    SubmitRecoveryResult,
    VenueAdapter,
} from "./execution-contracts"
import type { ExecutionIdentityContext } from "./execution-identity-constants"
import {
    createExecutionErrorDetail,
    formatExecutionError,
    getErrorMessage,
    getExecutionErrorDetail,
} from "./utils"

export function normalizeExecutionResultIdentity(
    result: ExecutionResult,
    identity: ExecutionIdentityContext,
    defaultCommitOutcome: ExecutionIdentityContext["commitOutcome"] = "accepted"
): ExecutionResult {
    const canonicalOrderId = result.canonicalOrderId ?? identity.canonicalOrderId
    const providerOrderId = result.providerOrderId ??
        (result.orderId && result.orderId !== canonicalOrderId ? result.orderId : identity.providerOrderId)
    const providerClientOrderId = result.providerClientOrderId ?? identity.providerClientOrderId
    const commitOutcome = result.commitOutcome ??
        (result.status === "rejected" ? "rejected" : defaultCommitOutcome)

    return {
        ...result,
        orderId: canonicalOrderId,
        canonicalOrderId,
        providerOrderId,
        providerClientOrderId,
        providerOrderAliases: result.providerOrderAliases ?? identity.providerOrderAliases,
        submitAttemptId: result.submitAttemptId ?? identity.submitAttemptId,
        submitAttemptSequence: result.submitAttemptSequence ?? identity.submitAttemptSequence,
        commitOutcome,
        signedOrderFingerprint: result.signedOrderFingerprint ?? identity.signedOrderFingerprint,
        signedOrderMetadata: result.signedOrderMetadata ?? identity.signedOrderMetadata,
    }
}

export function createCommitUnknownExecutionResult(args: {
    identity: ExecutionIdentityContext
    error: unknown
    recovery?: Exclude<SubmitRecoveryResult, { outcome: "accepted" }>
}): ExecutionResult {
    const detail = getExecutionErrorDetail(args.error)
    const message = args.recovery?.message ?? detail?.message ?? getErrorMessage(args.error)
    const providerOrderAliases = mergeRecoveryProviderAliases(args.identity, args.recovery)
    const errorDetail = createExecutionErrorDetail("venue", message, {
        code: "COMMIT_UNKNOWN",
        retryable: false,
        details: {
            originalError: detail ?? getErrorMessage(args.error),
            recovery: args.recovery,
            canonicalOrderId: args.identity.canonicalOrderId,
            providerClientOrderId: args.identity.providerClientOrderId,
            providerOrderAliases,
        },
    })

    return {
        orderId: args.identity.canonicalOrderId,
        canonicalOrderId: args.identity.canonicalOrderId,
        providerClientOrderId: args.identity.providerClientOrderId,
        providerOrderId: args.identity.providerOrderId,
        providerOrderAliases,
        submitAttemptId: args.identity.submitAttemptId,
        submitAttemptSequence: args.identity.submitAttemptSequence,
        commitOutcome: "commit_unknown",
        signedOrderFingerprint: args.identity.signedOrderFingerprint,
        signedOrderMetadata: args.identity.signedOrderMetadata,
        status: "pending",
        filledQuantity: 0,
        timestamp: Date.now(),
        error: formatExecutionError(errorDetail),
        errorDetail,
    }
}

export function createRejectedSubmitExecutionResult(args: {
    identity: ExecutionIdentityContext
    error: unknown
}): ExecutionResult {
    const detail = getExecutionErrorDetail(args.error) ??
        createExecutionErrorDetail("internal", getErrorMessage(args.error), {
            retryable: false,
        })

    return {
        orderId: args.identity.canonicalOrderId,
        canonicalOrderId: args.identity.canonicalOrderId,
        providerClientOrderId: args.identity.providerClientOrderId,
        providerOrderId: args.identity.providerOrderId,
        providerOrderAliases: args.identity.providerOrderAliases,
        submitAttemptId: args.identity.submitAttemptId,
        submitAttemptSequence: args.identity.submitAttemptSequence,
        commitOutcome: "rejected",
        signedOrderFingerprint: args.identity.signedOrderFingerprint,
        signedOrderMetadata: args.identity.signedOrderMetadata,
        status: "rejected",
        filledQuantity: 0,
        timestamp: Date.now(),
        error: formatExecutionError(detail),
        errorDetail: detail,
    }
}

export function createPreparedSubmitExecutionResult(identity: ExecutionIdentityContext): ExecutionResult {
    return {
        orderId: identity.canonicalOrderId,
        canonicalOrderId: identity.canonicalOrderId,
        providerClientOrderId: identity.providerClientOrderId,
        providerOrderId: identity.providerOrderId,
        providerOrderAliases: identity.providerOrderAliases,
        submitAttemptId: identity.submitAttemptId,
        submitAttemptSequence: identity.submitAttemptSequence,
        commitOutcome: "commit_unknown",
        signedOrderFingerprint: identity.signedOrderFingerprint,
        signedOrderMetadata: identity.signedOrderMetadata,
        status: "pending",
        filledQuantity: 0,
        timestamp: Date.now(),
    }
}

export async function submitOrderWithIdentity(args: {
    venue: VenueAdapter
    intent: OrderIntent
    context: SubmitOrderContext
}): Promise<ExecutionResult> {
    return await submitWithIdentity({
        ...args,
        submit: async () => await args.venue.submitOrder(args.intent, args.context),
    })
}

export async function submitWithIdentity(args: {
    venue: VenueAdapter
    intent: OrderIntent
    context: SubmitOrderContext
    submit: () => Promise<ExecutionResult>
}): Promise<ExecutionResult> {
    try {
        const result = await args.submit()
        const normalizedResult = normalizeExecutionResultIdentity(result, args.context.identity)
        if (normalizedResult.status !== "rejected") {
            return normalizedResult
        }

        return await recoverRejectedSubmitResult(args, normalizedResult)
    } catch (error) {
        return await recoverSubmitError(args, error)
    }
}

async function recoverRejectedSubmitResult(
    args: {
        venue: VenueAdapter
        intent: OrderIntent
        context: SubmitOrderContext
    },
    result: ExecutionResult
): Promise<ExecutionResult> {
    if (!args.venue.recoverSubmittedOrder) {
        return result
    }

    const resultError = createRejectedResultError(result)
    const recovery = await runRecoveryProbe(args.venue, args.intent, args.context, resultError)
    if (recovery.outcome === "accepted") {
        return normalizeExecutionResultIdentity(recovery.result, args.context.identity, "recovered")
    }

    if (recovery.outcome === "not_found" && !isRecoveryProbeFailure(recovery)) {
        return result
    }

    return createCommitUnknownExecutionResult({
        identity: args.context.identity,
        error: resultError,
        recovery,
    })
}

async function recoverSubmitError(
    args: {
        venue: VenueAdapter
        intent: OrderIntent
        context: SubmitOrderContext
    },
    error: unknown
): Promise<ExecutionResult> {
    const commitOutcome = classifySubmitError(args.venue, error, args.intent, args.context)
    if (commitOutcome !== "commit_unknown") {
        return createRejectedSubmitExecutionResult({
            identity: args.context.identity,
            error,
        })
    }

    const recovery = await runRecoveryProbe(args.venue, args.intent, args.context, error)
    if (recovery.outcome === "accepted") {
        return normalizeExecutionResultIdentity(recovery.result, args.context.identity, "recovered")
    }

    return createCommitUnknownExecutionResult({
        identity: args.context.identity,
        error,
        recovery,
    })
}

function createRejectedResultError(
    result: ExecutionResult
): Error & { executionError: NonNullable<ExecutionResult["errorDetail"]> } {
    const detail = result.errorDetail ??
        createExecutionErrorDetail("venue", result.error ?? "Provider returned rejected submit result", {
            code: "SUBMIT_RESULT_REJECTED",
            retryable: false,
            details: {
                orderId: result.orderId,
                providerOrderId: result.providerOrderId,
                providerClientOrderId: result.providerClientOrderId,
                status: result.status,
                commitOutcome: result.commitOutcome,
            },
        })
    const error = new Error(formatExecutionError(detail)) as Error & {
        executionError: NonNullable<ExecutionResult["errorDetail"]>
    }
    error.executionError = detail
    return error
}

function isRecoveryProbeFailure(
    recovery: Extract<SubmitRecoveryResult, { outcome: "not_found" | "ambiguous" }>
): boolean {
    return recovery.details?.recoveryError !== undefined
}

function mergeRecoveryProviderAliases(
    identity: ExecutionIdentityContext,
    recovery?: Exclude<SubmitRecoveryResult, { outcome: "accepted" }>
): string[] {
    const aliases = new Set(identity.providerOrderAliases)
    for (const match of recovery?.matches ?? []) {
        if (match.providerOrderId) {
            aliases.add(match.providerOrderId)
        }
        if (match.orderId && match.orderId !== identity.canonicalOrderId) {
            aliases.add(match.orderId)
        }
    }

    aliases.delete(identity.canonicalOrderId)
    aliases.delete(identity.providerClientOrderId)
    return Array.from(aliases).sort((left, right) => left.localeCompare(right))
}

function classifySubmitError(
    venue: VenueAdapter,
    error: unknown,
    intent: OrderIntent,
    context: SubmitOrderContext
): ExecutionIdentityContext["commitOutcome"] {
    const providerOutcome = venue.classifySubmitError?.(error, intent, context)
    if (providerOutcome) {
        return providerOutcome
    }

    const detail = getExecutionErrorDetail(error)
    if (!detail?.retryable) {
        return "rejected"
    }

    if (detail.source === "network" || detail.source === "timeout" || detail.source === "venue") {
        return "commit_unknown"
    }

    return "rejected"
}

async function runRecoveryProbe(
    venue: VenueAdapter,
    intent: OrderIntent,
    context: SubmitOrderContext,
    error: unknown
): Promise<SubmitRecoveryResult> {
    if (!venue.recoverSubmittedOrder) {
        return {
            outcome: "not_found",
            message: "Provider does not expose a bounded commit-unknown recovery probe",
        }
    }

    try {
        return await venue.recoverSubmittedOrder(intent, context, error)
    } catch (recoveryError) {
        const detail = getExecutionErrorDetail(recoveryError)
        return {
            outcome: "not_found",
            message: `Provider recovery probe failed closed: ${detail?.message ?? getErrorMessage(recoveryError)}`,
            details: {
                recoveryError: detail ?? getErrorMessage(recoveryError),
            },
        }
    }
}

import {
    type ExecutionIdentityContext,
    type ExecutionIdentityInput,
    type ExecutionOrderRole,
    type PreparedExecutionIdentity,
    EXECUTION_IDENTITY_VENUE_CODES,
    EXECUTION_IDENTITY_VOLATILE_METADATA_KEYS,
} from "./execution-identity-constants"

export function normalizeExecutionRole(role: ExecutionIdentityInput["role"]): ExecutionOrderRole {
    if (role === "adjustment") {
        return "entry"
    }

    if (role === "take_profit" || role === "stop_loss") {
        return role
    }

    return role
}

export function mergeExecutionIdentity(
    base: ExecutionIdentityContext,
    prepared?: PreparedExecutionIdentity
): ExecutionIdentityContext {
    if (!prepared) {
        return base
    }

    return {
        ...base,
        ...prepared,
        canonicalOrderId: prepared.canonicalOrderId ?? base.canonicalOrderId,
        providerClientOrderId: prepared.providerClientOrderId ?? base.providerClientOrderId,
        providerOrderAliases: mergeIdentityAliases([
            ...base.providerOrderAliases,
            ...(prepared.providerOrderAliases ?? []),
        ]),
        submitAttemptId: prepared.submitAttemptId ?? base.submitAttemptId,
        submitAttemptSequence: prepared.submitAttemptSequence ?? base.submitAttemptSequence,
        commitOutcome: prepared.commitOutcome ?? base.commitOutcome,
        signedOrderFingerprint: prepared.signedOrderFingerprint ?? base.signedOrderFingerprint,
        signedOrderMetadata: prepared.signedOrderMetadata ?? base.signedOrderMetadata,
        venue: prepared.venue ?? base.venue,
        role: prepared.role ?? base.role,
        sequence: prepared.sequence ?? base.sequence,
    }
}

export function mergeIdentityAliases(orderIds: Array<string | undefined>): string[] {
    const seen = new Set<string>()

    for (const orderId of orderIds) {
        const normalized = orderId?.trim()
        if (!normalized) {
            continue
        }
        seen.add(normalized)
    }

    return Array.from(seen).sort((left, right) => left.localeCompare(right))
}

export function getExecutionIdentityCandidates(identity: {
    orderId?: string
    canonicalOrderId?: string
    providerOrderId?: string
    providerClientOrderId?: string
    providerOrderAliases?: string[]
    signedOrderFingerprint?: string
}): string[] {
    return mergeIdentityAliases([
        identity.canonicalOrderId,
        identity.orderId,
        identity.providerClientOrderId,
        identity.providerOrderId,
        identity.signedOrderFingerprint,
        ...(identity.providerOrderAliases ?? []),
    ])
}

export function stableStringify(value: unknown): string {
    return JSON.stringify(sortJson(value))
}

export function normalizeIdentityIntent(value: unknown): unknown {
    if (!isRecord(value)) {
        return value
    }

    const normalized: Record<string, unknown> = { ...value }
    if (isRecord(normalized.metadata)) {
        const metadata = { ...normalized.metadata }
        for (const key of EXECUTION_IDENTITY_VOLATILE_METADATA_KEYS) {
            delete metadata[key]
        }
        normalized.metadata = metadata
    }

    return normalized
}

export function normalizeIdentitySequence(sequence: number): number {
    if (!Number.isInteger(sequence) || sequence < 0 || sequence > 1295) {
        throw new Error(`Execution identity sequence must be an integer from 0 to 1295. Received ${sequence}`)
    }

    return sequence
}

export function normalizeSubmitAttemptSequence(attemptSequence: number): number {
    if (!Number.isInteger(attemptSequence) || attemptSequence < 1 || attemptSequence > 9999) {
        throw new Error(`Submit attempt sequence must be an integer from 1 to 9999. Received ${attemptSequence}`)
    }

    return attemptSequence
}

export function resolveIdentityVenueCode(venue: string): string {
    const normalized = venue.trim().toLowerCase()
    const known = EXECUTION_IDENTITY_VENUE_CODES[normalized]
    if (known) {
        return known
    }

    const letters = normalized.replace(/[^a-z0-9]/g, "")
    return (letters.slice(0, 2) || "xx").padEnd(2, "x")
}

function sortJson(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sortJson)
    }

    if (typeof value === "bigint") {
        return value.toString()
    }

    if (!isRecord(value)) {
        return value
    }

    return Object.keys(value)
        .sort((left, right) => left.localeCompare(right))
        .reduce<Record<string, unknown>>((accumulator, key) => {
            accumulator[key] = sortJson(value[key])
            return accumulator
        }, {})
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}

import { sha256, sha256Hex } from "./sha256"
import {
    type ExecutionIdentityContext,
    type ExecutionIdentityInput,
    type ExecutionOrderRole,
    EXECUTION_IDENTITY_BASE32_ALPHABET,
    EXECUTION_IDENTITY_ROLE_CODES,
} from "./execution-identity-constants"
import {
    normalizeExecutionRole,
    normalizeIdentityIntent,
    normalizeIdentitySequence,
    normalizeSubmitAttemptSequence,
    resolveIdentityVenueCode,
    stableStringify,
} from "./execution-identity-shared"

export * from "./execution-identity-constants"
export * from "./execution-identity-shared"

export function createExecutionIdentity(input: ExecutionIdentityInput): ExecutionIdentityContext {
    const sequence = normalizeIdentitySequence(input.sequence ?? 1)
    const attemptSequence = normalizeSubmitAttemptSequence(input.attemptSequence ?? 1)
    const venueCode = resolveIdentityVenueCode(input.venue)
    const role = normalizeExecutionRole(input.role)
    const roleCode = EXECUTION_IDENTITY_ROLE_CODES[role]
    const sequenceCode = sequence.toString(36).padStart(2, "0")
    const normalizedIntent = stableStringify(normalizeIdentityIntent(input.normalizedIntent))
    const hashInput = [
        input.strategyId,
        input.runId,
        role,
        input.instrument,
        String(sequence),
        normalizedIntent,
    ].join("|")
    const suffix = toBase32(sha256(new TextEncoder().encode(hashInput))).slice(0, 10)
    const canonicalOrderId = `v${venueCode}${roleCode}${sequenceCode}${suffix}`

    return {
        canonicalOrderId,
        providerClientOrderId: canonicalOrderId,
        providerOrderAliases: [],
        submitAttemptId: createSubmitAttemptId(canonicalOrderId, attemptSequence),
        submitAttemptSequence: attemptSequence,
        commitOutcome: "accepted",
        venue: input.venue,
        role,
        sequence,
    }
}

export function createChildExecutionIdentity(
    parent: ExecutionIdentityContext,
    role: Extract<ExecutionOrderRole, "take_profit" | "stop_loss">
): ExecutionIdentityContext {
    return createExecutionIdentity({
        venue: parent.venue,
        strategyId: parent.canonicalOrderId,
        runId: parent.canonicalOrderId,
        role,
        instrument: parent.canonicalOrderId,
        normalizedIntent: {
            parentCanonicalOrderId: parent.canonicalOrderId,
            role,
        },
        sequence: parent.sequence,
        attemptSequence: parent.submitAttemptSequence,
    })
}

export function createSubmitAttemptId(canonicalOrderId: string, attemptSequence: number): string {
    return sha256Hex(`${canonicalOrderId}|attempt:${normalizeSubmitAttemptSequence(attemptSequence)}`).slice(0, 24)
}

function toBase32(bytes: Uint8Array): string {
    let output = ""
    let value = 0
    let bits = 0

    for (const byte of bytes) {
        value = (value << 8) | byte
        bits += 8

        while (bits >= 5) {
            output += EXECUTION_IDENTITY_BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
            bits -= 5
        }
    }

    if (bits > 0) {
        output += EXECUTION_IDENTITY_BASE32_ALPHABET[(value << (5 - bits)) & 31]
    }

    return output
}

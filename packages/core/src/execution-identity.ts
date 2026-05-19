import { createHash } from "crypto"
import type { OrderIntent } from "./order-intent-types"
import type { OrderAction } from "./order-types"

export const PROVIDER_IDENTITY_CAPABILITIES = [
    "native_client_id",
    "deterministic_signed_id",
    "provider_id_only",
] as const

export type ProviderIdentityCapability = typeof PROVIDER_IDENTITY_CAPABILITIES[number]

export const EXECUTION_COMMIT_OUTCOMES = [
    "accepted",
    "rejected",
    "commit_unknown",
    "recovered",
] as const

export type ExecutionCommitOutcome = typeof EXECUTION_COMMIT_OUTCOMES[number]

export const EXECUTION_IDENTITY_VENUES = [
    "mt5",
    "alpaca-options",
    "okx-swap",
    "polymarket",
] as const

export type ExecutionIdentityVenue = typeof EXECUTION_IDENTITY_VENUES[number]

export const EXECUTION_ORDER_ROLES = [
    "entry",
    "close",
    "modify",
    "cancel",
    "take_profit",
    "stop_loss",
] as const

export type ExecutionOrderRole = typeof EXECUTION_ORDER_ROLES[number]

export interface ExecutionIdentityInput {
    venue: string
    strategyId: string
    runId: string
    role: ExecutionOrderRole | OrderAction
    instrument: string
    normalizedIntent: unknown
    sequence?: number
    attemptSequence?: number
}

export interface ExecutionIdentityContext {
    canonicalOrderId: string
    providerClientOrderId: string
    providerOrderId?: string
    providerOrderAliases: string[]
    submitAttemptId: string
    submitAttemptSequence: number
    commitOutcome: ExecutionCommitOutcome
    signedOrderFingerprint?: string
    signedOrderMetadata?: Record<string, unknown>
    venue: string
    role: ExecutionOrderRole
    sequence: number
}

export interface PreparedExecutionIdentity extends Partial<ExecutionIdentityContext> {
    providerClientOrderId?: string
    signedOrderFingerprint?: string
    signedOrderMetadata?: Record<string, unknown>
}

export interface ExecutionIdentityFields {
    canonicalOrderId?: string
    providerOrderId?: string
    providerClientOrderId?: string
    providerOrderAliases?: string[]
    submitAttemptId?: string
    submitAttemptSequence?: number
    commitOutcome?: ExecutionCommitOutcome
    signedOrderFingerprint?: string
    signedOrderMetadata?: Record<string, unknown>
}

const VENUE_CODES: Record<string, string> = {
    mt5: "mt",
    alpaca: "al",
    "alpaca-options": "al",
    okx: "ok",
    "okx-swap": "ok",
    polymarket: "pm",
}

const ROLE_CODES: Record<ExecutionOrderRole | OrderAction, string> = {
    entry: "e",
    adjustment: "e",
    close: "c",
    modify: "m",
    cancel: "x",
    take_profit: "t",
    stop_loss: "s",
}

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"
const VOLATILE_IDENTITY_METADATA_KEYS = new Set([
    "submitAttemptSequence",
    "cancelAt",
    "estimatedPrice",
    "fundingRate",
    "estimatedRoundTripFees",
    "riskAmount",
    "riskPercent",
])

export function createExecutionIdentity(input: ExecutionIdentityInput): ExecutionIdentityContext {
    const sequence = normalizeSequence(input.sequence ?? 1)
    const attemptSequence = normalizeAttemptSequence(input.attemptSequence ?? 1)
    const venueCode = resolveVenueCode(input.venue)
    const role = normalizeExecutionRole(input.role)
    const roleCode = ROLE_CODES[role]
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
    const suffix = toBase32(createHash("sha256").update(hashInput).digest()).slice(0, 10)
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

export function createSubmitAttemptId(canonicalOrderId: string, attemptSequence: number): string {
    return createHash("sha256")
        .update(`${canonicalOrderId}|attempt:${normalizeAttemptSequence(attemptSequence)}`)
        .digest("hex")
        .slice(0, 24)
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

function resolveVenueCode(venue: string): string {
    const normalized = venue.trim().toLowerCase()
    const known = VENUE_CODES[normalized]
    if (known) {
        return known
    }

    const letters = normalized.replace(/[^a-z0-9]/g, "")
    return (letters.slice(0, 2) || "xx").padEnd(2, "x")
}

function normalizeSequence(sequence: number): number {
    if (!Number.isInteger(sequence) || sequence < 0 || sequence > 1295) {
        throw new Error(`Execution identity sequence must be an integer from 0 to 1295. Received ${sequence}`)
    }

    return sequence
}

function normalizeAttemptSequence(attemptSequence: number): number {
    if (!Number.isInteger(attemptSequence) || attemptSequence < 1 || attemptSequence > 9999) {
        throw new Error(`Submit attempt sequence must be an integer from 1 to 9999. Received ${attemptSequence}`)
    }

    return attemptSequence
}

function toBase32(bytes: Buffer): string {
    let output = ""
    let value = 0
    let bits = 0

    for (const byte of bytes) {
        value = (value << 8) | byte
        bits += 8

        while (bits >= 5) {
            output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
            bits -= 5
        }
    }

    if (bits > 0) {
        output += BASE32_ALPHABET[(value << (5 - bits)) & 31]
    }

    return output
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

function normalizeIdentityIntent(value: unknown): unknown {
    if (!isRecord(value)) {
        return value
    }

    const normalized: Record<string, unknown> = { ...value }
    if (isRecord(normalized.metadata)) {
        const metadata = { ...normalized.metadata }
        for (const key of VOLATILE_IDENTITY_METADATA_KEYS) {
            delete metadata[key]
        }
        normalized.metadata = metadata
    }

    return normalized
}

import type { Doc } from "../../_generated/dataModel"
export { readFiniteNumber } from "@valiq-trading/core"
import type { OrderDoc, StrategyDoc } from "./portfolioTypes"
import { getProviderInstrumentClaimAliases } from "../instrumentClaims"

const PORTFOLIO_STALE_AFTER_MS = 10 * 60 * 1000

export function collectExpectedExternalInstruments(
    strategies: StrategyDoc[]
): Set<string> {
    const expected = new Set<string>()

    for (const strategy of strategies) {
        const safetyPolicy = (strategy.policy as Record<string, unknown>).safety as Record<string, unknown> | undefined
        const expectedInstruments = safetyPolicy?.expectedExternalInstruments

        if (!Array.isArray(expectedInstruments)) {
            continue
        }

        for (const value of expectedInstruments) {
            if (typeof value !== "string") {
                continue
            }

            const instrument = value.trim()
            if (instrument.length === 0) {
                continue
            }

            expected.add(instrument)
        }
    }

    return expected
}

export function buildLiveInstrumentAliases(
    app: Doc<"strategies">["app"],
    instruments: string[]
): Map<string, Set<string>> {
    const aliases = new Map<string, Set<string>>()

    for (const instrument of instruments) {
        aliases.set(instrument, new Set(getProviderInstrumentClaimAliases(app, instrument)))
    }

    return aliases
}

export function setsIntersect(left: Set<string>, right: Set<string>): boolean {
    for (const value of left) {
        if (right.has(value)) {
            return true
        }
    }

    return false
}

export function readMetadataRecord(value: string | undefined): Record<string, unknown> | undefined {
    const parsed = parseJson<unknown>(value)
    return parsed && typeof parsed === "object"
        ? parsed as Record<string, unknown>
        : undefined
}

export function addExpectedExternalIdentifier(
    identifiers: Set<string>,
    value: unknown
): void {
    if (typeof value !== "string") {
        return
    }

    const normalized = value.trim()
    if (normalized.length === 0) {
        return
    }

    identifiers.add(normalized)
}

export function isExpectedExternalProviderRow(
    expectedExternalInstruments: Set<string>,
    row: {
        instrument: string
        metadata?: string
    }
): boolean {
    if (expectedExternalInstruments.has(row.instrument)) {
        return true
    }

    const metadata = readMetadataRecord(row.metadata)
    if (!metadata) {
        return false
    }

    const identifiers = new Set<string>()
    addExpectedExternalIdentifier(identifiers, metadata.tokenId)
    addExpectedExternalIdentifier(identifiers, metadata.marketSlug)
    addExpectedExternalIdentifier(identifiers, metadata.slug)
    addExpectedExternalIdentifier(identifiers, metadata.conditionId)
    addExpectedExternalIdentifier(identifiers, metadata.market)

    for (const identifier of identifiers) {
        if (expectedExternalInstruments.has(identifier)) {
            return true
        }
    }

    return false
}

export function isEntryLikeOrder(order: Pick<OrderDoc, "action">): boolean {
    return order.action === "entry" || order.action === "adjustment"
}

export function almostEqual(left: number, right: number): boolean {
    return Math.abs(left - right) <= 0.000001
}

export function hasNonZeroProviderAccountingMetadata(metadata: Record<string, unknown> | undefined): boolean {
    return isNonZeroFiniteNumber(metadata?.fillPnl) ||
        isNonZeroFiniteNumber(metadata?.profit) ||
        isNonZeroFiniteNumber(metadata?.fee) ||
        isNonZeroFiniteNumber(metadata?.commission) ||
        isNonZeroFiniteNumber(metadata?.swap)
}

export function readOrderIntentRecord(intent: unknown): Record<string, unknown> | undefined {
    return intent && typeof intent === "object"
        ? intent as Record<string, unknown>
        : undefined
}

function isNonZeroFiniteNumber(value: unknown): boolean {
    const number = typeof value === "number"
        ? value
        : typeof value === "string" && value.trim()
            ? Number(value)
            : undefined
    return number !== undefined && Number.isFinite(number) && number !== 0
}

export function createDriftSummary(args: {
    unownedPositionCount: number
    unownedOrderCount: number
    untrackedOwnedOrderCount: number
    closedPersistedOrders: string[]
    statusMismatches: string[]
    ownershipMismatches: string[]
    exposureViolations: string[]
    moneyAuditMismatches?: string[]
    unattributedClosures?: string[]
    unmatchedClosedPositions?: string[]
}): string | undefined {
    const parts: string[] = []

    if (args.moneyAuditMismatches && args.moneyAuditMismatches.length > 0) {
        parts.push(`${args.moneyAuditMismatches.length} account money reconciliation mismatch(es): ${args.moneyAuditMismatches.join(", ")}`)
    }

    if (args.unattributedClosures && args.unattributedClosures.length > 0) {
        parts.push(`${args.unattributedClosures.length} provider close(s) could not be safely attributed to a strategy-owned position: ${args.unattributedClosures.join(", ")}`)
    }

    if (args.unmatchedClosedPositions && args.unmatchedClosedPositions.length > 0) {
        parts.push(`${args.unmatchedClosedPositions.length} owned position(s) disappeared without matching broker close evidence: ${args.unmatchedClosedPositions.join(", ")}`)
    }

    if (args.unownedPositionCount > 0) {
        parts.push(`${args.unownedPositionCount} live position(s) lack a clean strategy owner`)
    }

    if (args.unownedOrderCount > 0) {
        parts.push(`${args.unownedOrderCount} live working order(s) lack a clean strategy owner`)
    }

    if (args.untrackedOwnedOrderCount > 0) {
        parts.push(`${args.untrackedOwnedOrderCount} owned live working order(s) were not matched to a canonical active order`)
    }

    if (args.closedPersistedOrders.length > 0) {
        parts.push(`${args.closedPersistedOrders.length} Convex-tracked working order(s) were no longer live at the provider`)
    }

    if (args.statusMismatches.length > 0) {
        parts.push(`${args.statusMismatches.length} working order(s) required status or quantity repair`)
    }

    if (args.ownershipMismatches.length > 0) {
        parts.push(`${args.ownershipMismatches.length} provider position ownership mismatch(es) were detected`)
    }

    if (args.exposureViolations.length > 0) {
        parts.push(`${args.exposureViolations.length} provider exposure governance violation(s) were detected`)
    }

    return parts.length > 0 ? parts.join("; ") : undefined
}

export function isStale(lastVerifiedAt: number | undefined, now: number): boolean {
    if (!lastVerifiedAt) {
        return true
    }

    return now - lastVerifiedAt > PORTFOLIO_STALE_AFTER_MS
}

export function buildProtectionLevels(
    orders: Array<{
        instrument: string
        limitPrice?: number
        stopPrice?: number
        metadata?: string
    }>
): Map<string, { stopLoss?: number; takeProfit?: number }> {
    const levels = new Map<string, { stopLoss?: number; takeProfit?: number }>()

    for (const order of orders) {
        const metadata = parseJson<Record<string, unknown>>(order.metadata)
        const orderType = typeof metadata?.type === "string"
            ? metadata.type
            : typeof metadata?.orderType === "string"
                ? metadata.orderType
                : undefined
        const current = levels.get(order.instrument) ?? {}

        if (metadata?.kind === "protection") {
            if (order.stopPrice !== undefined) {
                current.stopLoss = order.stopPrice
            }
            if (order.limitPrice !== undefined) {
                current.takeProfit = order.limitPrice
            }
        } else if (orderType === "STOP_MARKET" || orderType === "STOP") {
            current.stopLoss = order.stopPrice
        } else if (orderType === "TAKE_PROFIT_MARKET" || orderType === "TAKE_PROFIT") {
            current.takeProfit = order.stopPrice
        }

        levels.set(order.instrument, current)
    }

    return levels
}

export function computeHash(value: unknown): string {
    const canonical = JSON.stringify(canonicalize(value))
    let hash = 0x811c9dc5

    for (let i = 0; i < canonical.length; i++) {
        hash ^= canonical.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
    }

    return (hash >>> 0).toString(16).padStart(8, "0")
}

export function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map((entry) => canonicalize(entry))
    }

    if (value && typeof value === "object") {
        const record = value as Record<string, unknown>
        const keys = Object.keys(record).sort((left, right) => left.localeCompare(right))
        const normalized: Record<string, unknown> = {}
        for (const key of keys) {
            normalized[key] = canonicalize(record[key])
        }
        return normalized
    }

    return value
}

export function parseJson<T>(value: string | undefined): T | undefined {
    if (!value) {
        return undefined
    }

    try {
        return JSON.parse(value) as T
    } catch {
        return undefined
    }
}

export function readOrderCancelAt(order: OrderDoc | undefined): number | undefined {
    if (!order || !order.intent || typeof order.intent !== "object") {
        return undefined
    }

    const metadata = (order.intent as Record<string, unknown>).metadata
    if (!metadata || typeof metadata !== "object") {
        return undefined
    }

    const cancelAt = (metadata as Record<string, unknown>).cancelAt
    return typeof cancelAt === "number" && Number.isFinite(cancelAt)
        ? cancelAt
        : undefined
}

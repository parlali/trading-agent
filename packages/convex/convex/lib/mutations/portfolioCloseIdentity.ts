import type { Doc, Id } from "../../_generated/dataModel"
import type { ProviderPositionClosureInput } from "./portfolioTypes"
import {
    parseJson,
    readMetadataRecord,
    readOrderIntentRecord,
} from "./portfolioUtils"

export type ProviderClosePositionCandidate = Pick<
    Doc<"provider_positions">,
    "instrument" |
    "accountId" |
    "side" |
    "quantity" |
    "entryPrice" |
    "metadata" |
    "providerPositionId" |
    "positionKey" |
    "syncedAt"
> & {
    strategyId: Id<"strategies">
    runId?: Id<"strategy_runs">
    sourceOrder?: Doc<"orders">
}

export function buildProviderPositionIdentityCandidates(
    position: Pick<ProviderClosePositionCandidate, "providerPositionId" | "positionKey" | "metadata">
): Set<string> {
    const identifiers = new Set<string>()
    addKnownIdentifier(identifiers, position.positionKey)
    if (position.providerPositionId) {
        identifiers.add(position.providerPositionId)
    }

    const metadata = readMetadataRecord(position.metadata)
    addKnownIdentifier(identifiers, metadata?.ticket)
    addKnownIdentifier(identifiers, metadata?.identifier)
    addKnownIdentifier(identifiers, metadata?.posId)
    addKnownIdentifier(identifiers, metadata?.positionId)
    addKnownIdentifier(identifiers, metadata?.providerPositionId)
    addKnownIdentifier(identifiers, metadata?.tokenId)
    addKnownIdentifier(identifiers, metadata?.asset)
    return identifiers
}

export function buildPositionClosureIdentityCandidates(
    closure: Pick<ProviderPositionClosureInput, "providerPositionId" | "metadata">
): Set<string> {
    const identifiers = new Set<string>()
    addKnownIdentifier(identifiers, closure.providerPositionId)

    const metadata = parseJson<Record<string, unknown>>(closure.metadata)
    addKnownIdentifier(identifiers, metadata?.ticket)
    addKnownIdentifier(identifiers, metadata?.orderId)
    addKnownIdentifier(identifiers, metadata?.triggeredOrderId)
    addKnownIdentifier(identifiers, metadata?.clientOrderId)
    addKnownIdentifier(identifiers, metadata?.algoId)
    addKnownIdentifier(identifiers, metadata?.algoClOrdId)
    addKnownIdentifier(identifiers, metadata?.actualOrdId)
    addKnownIdentifier(identifiers, metadata?.posId)
    addKnownIdentifier(identifiers, metadata?.positionId)
    addKnownIdentifier(identifiers, metadata?.providerPositionId)
    addKnownIdentifier(identifiers, metadata?.providerPositionKey)
    addKnownIdentifier(identifiers, metadata?.tokenId)
    addKnownIdentifier(identifiers, metadata?.asset)
    if (Array.isArray(metadata?.providerOrderAliases)) {
        for (const alias of metadata.providerOrderAliases) {
            addKnownIdentifier(identifiers, alias)
        }
    }
    return identifiers
}

export function hasSharedProviderPositionIdentity(
    left: Set<string>,
    right: Set<string>
): boolean {
    for (const identifier of left) {
        if (right.has(identifier)) {
            return true
        }
    }

    return false
}

export function addKnownIdentifier(
    identifiers: Set<string>,
    value: unknown
): void {
    const identifier = readIdentifier(value)
    if (identifier) {
        identifiers.add(identifier)
    }
}

export function readIdentifier(value: unknown): string | undefined {
    if (typeof value === "string" && value.trim().length > 0) {
        return value.trim()
    }

    if (typeof value === "number" && Number.isFinite(value)) {
        return String(value)
    }

    return undefined
}

export function buildProviderCloseOrderId(
    app: Doc<"strategies">["app"],
    position: Pick<Doc<"provider_positions">, "positionKey">,
    closure: { closedAt: number }
): string {
    return `provider-close:${app}:${position.positionKey}:${closure.closedAt}`
}

export function resolveProviderCloseOrderProviderId(
    closure: { metadata?: string }
): string | undefined {
    return readIdentifier(parseJson<Record<string, unknown>>(closure.metadata)?.orderId)
}

export function resolveProviderClosureDealIdFromMetadata(
    metadata: Record<string, unknown> | undefined
): string | undefined {
    return readIdentifier(metadata?.dealId) ??
        readIdentifier(metadata?.providerDealId) ??
        readIdentifier(metadata?.ticket)
}

export function resolveProviderClosureDealId(
    closure: { metadata?: string }
): string | undefined {
    return resolveProviderClosureDealIdFromMetadata(parseJson<Record<string, unknown>>(closure.metadata))
}

export function orderBelongsToAccount(
    order: Pick<Doc<"orders">, "app" | "venue" | "accountId">,
    app: Doc<"strategies">["app"],
    accountId: string
): boolean {
    return (order.app ?? order.venue) === app && order.accountId === accountId
}

export function buildPositionClosureKey(closure: ProviderPositionClosureInput): string {
    const parts = [
        closure.instrument,
        closure.side,
        closure.closedAt,
        resolveProviderCloseOrderProviderId(closure) ?? closure.providerPositionId ?? "",
    ]
    const dealId = resolveProviderClosureDealId(closure)
    if (dealId) {
        parts.push(dealId)
    }
    return parts.join(":")
}

export function describeClosure(closure: ProviderPositionClosureInput): string {
    return [
        closure.instrument,
        closure.side,
        closure.quantity,
        new Date(closure.closedAt).toISOString(),
    ].join(":")
}

export function readOrderIntentMetadata(order: Doc<"orders">): Record<string, unknown> | undefined {
    const intent = readOrderIntentRecord(order.intent)
    const metadata = intent?.metadata
    return metadata !== undefined && typeof metadata === "object" && metadata !== null
        ? metadata as Record<string, unknown>
        : undefined
}

export function isSyntheticProviderCloseOrder(order: Doc<"orders">): boolean {
    return order.orderId.startsWith("provider-close:")
}

export function isRetiredProviderCloseOrder(order: Doc<"orders">): boolean {
    return isSyntheticProviderCloseOrder(order) &&
        order.status === "cancelled" &&
        readOrderIntentMetadata(order)?.providerReconciledCloseRetired === true
}

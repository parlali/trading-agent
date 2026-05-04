import type { Doc, Id } from "../../_generated/dataModel"
import type {
    PortfolioMutationCtx,
    ProviderPositionClosureInput,
    StrategyDoc,
} from "./portfolioTypes"
import { appendOrderTransition, upsertOrderRow } from "./orders"
import {
    almostEqual,
    parseJson,
    readMetadataRecord,
} from "./portfolioUtils"
import { resolveLatestRunIdForStrategy } from "./portfolioOrderRuns"

export async function reconcileProviderPositionClosures(
    ctx: PortfolioMutationCtx,
    args: {
        app: Doc<"strategies">["app"]
        strategyMap: Map<string, StrategyDoc>
        existingProviderPositions: Doc<"provider_positions">[]
        livePositionKeys: Set<string>
        positionClosures: ProviderPositionClosureInput[]
        updatedAt: number
    }
): Promise<void> {
    if (args.positionClosures.length === 0) {
        return
    }

    const candidatePositions = args.existingProviderPositions.filter((position) =>
        position.ownershipStatus === "owned" &&
        position.strategyId !== undefined &&
        position.expectedExternal !== true &&
        !args.livePositionKeys.has(position.positionKey)
    )
    const latestRunIdsByStrategy = new Map<string, Id<"strategy_runs"> | undefined>()

    for (const position of candidatePositions) {
        const strategy = position.strategyId
            ? args.strategyMap.get(String(position.strategyId))
            : undefined
        if (!strategy || !position.strategyId) {
            continue
        }

        const strategyKey = String(position.strategyId)
        const runId = latestRunIdsByStrategy.has(strategyKey)
            ? latestRunIdsByStrategy.get(strategyKey)
            : await resolveLatestRunIdForStrategy(ctx, position.strategyId)
        latestRunIdsByStrategy.set(strategyKey, runId)
        if (!runId) {
            continue
        }

        const closure = resolveMatchingPositionClosure(position, args.positionClosures)
        if (!closure) {
            continue
        }

        const syntheticOrderId = buildProviderCloseOrderId(args.app, position, closure)
        const existingOrder = await ctx.db
            .query("orders")
            .withIndex("by_order_id", (q) => q.eq("orderId", syntheticOrderId))
            .first()

        await upsertOrderRow(ctx, {
            orderId: syntheticOrderId,
            providerOrderId: resolveProviderCloseOrderProviderId(closure) ?? syntheticOrderId,
            providerOrderAliases: [],
            runId: existingOrder?.runId ?? runId,
            strategyId: position.strategyId,
            venue: args.app,
            instrument: position.instrument,
            status: "filled",
            action: "close",
            quantity: closure.quantity,
            filledQuantity: closure.quantity,
            remainingQuantity: 0,
            avgFillPrice: closure.fillPrice,
            submittedAt: closure.closedAt,
            updatedAt: closure.closedAt,
            intent: buildProviderCloseIntent(position, closure),
            metadata: {
                providerReconciledClose: true,
            },
            lastTransitionSequence: existingOrder?.lastTransitionSequence ?? 0,
            polling: {
                pollIntervalMs: 0,
                timeoutMs: 0,
                startedAt: closure.closedAt,
                lastCheckedAt: args.updatedAt,
            },
        })

        if ((existingOrder?.lastTransitionSequence ?? 0) === 0) {
            await appendOrderTransition(ctx, {
                orderId: syntheticOrderId,
                runId: existingOrder?.runId ?? runId,
                strategyId: position.strategyId,
                type: "terminal",
                status: "filled",
                previousStatus: undefined,
                reason: "Provider reconciliation imported a broker-reported position close after the owned position disappeared from the live portfolio",
                details: {
                    providerPositionId: closure.providerPositionId,
                    fillPrice: closure.fillPrice,
                    quantity: closure.quantity,
                    metadata: parseJson<Record<string, unknown>>(closure.metadata),
                },
                timestamp: closure.closedAt,
            })

            await ctx.db.insert("trade_events", {
                runId: existingOrder?.runId ?? runId,
                strategyId: position.strategyId,
                app: args.app,
                eventType: "filled",
                payload: JSON.stringify({
                    providerReconciledClose: true,
                    instrument: position.instrument,
                    providerPositionId: closure.providerPositionId,
                    quantity: closure.quantity,
                    fillPrice: closure.fillPrice,
                    closedAt: closure.closedAt,
                    metadata: parseJson<Record<string, unknown>>(closure.metadata),
                }),
                timestamp: closure.closedAt,
            })
        }
    }
}
export function resolveMatchingPositionClosure(
    position: Doc<"provider_positions">,
    closures: ProviderPositionClosureInput[]
): ProviderPositionClosureInput | undefined {
    const candidates = closures.filter((closure) =>
        closure.instrument === position.instrument &&
        closure.side === position.side &&
        closure.closedAt >= position.syncedAt
    )

    if (candidates.length === 0) {
        return undefined
    }

    const positionIds = buildProviderPositionIdentityCandidates(position)
    const strongMatches = candidates.filter((closure) =>
        closure.providerPositionId !== undefined &&
        positionIds.has(closure.providerPositionId)
    )
    if (strongMatches.length > 0) {
        return strongMatches.sort((left, right) => right.closedAt - left.closedAt)[0]
    }

    const quantityMatches = candidates.filter((closure) => almostEqual(closure.quantity, position.quantity))
    if (quantityMatches.length === 1) {
        return quantityMatches[0]
    }

    if (candidates.length === 1) {
        return candidates[0]
    }

    return candidates.sort((left, right) => right.closedAt - left.closedAt)[0]
}

export function buildProviderPositionIdentityCandidates(
    position: Pick<Doc<"provider_positions">, "providerPositionId" | "metadata">
): Set<string> {
    const identifiers = new Set<string>()
    if (position.providerPositionId) {
        identifiers.add(position.providerPositionId)
    }

    const metadata = readMetadataRecord(position.metadata)
    addKnownIdentifier(identifiers, metadata?.ticket)
    addKnownIdentifier(identifiers, metadata?.identifier)
    addKnownIdentifier(identifiers, metadata?.positionId)
    addKnownIdentifier(identifiers, metadata?.providerPositionId)
    return identifiers
}

export function addKnownIdentifier(
    identifiers: Set<string>,
    value: unknown
): void {
    if (typeof value === "string" && value.trim().length > 0) {
        identifiers.add(value.trim())
        return
    }

    if (typeof value === "number" && Number.isFinite(value)) {
        identifiers.add(String(value))
    }
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
    const metadata = parseJson<Record<string, unknown>>(closure.metadata)
    const orderId = metadata?.orderId
    if (typeof orderId === "string" && orderId.trim().length > 0) {
        return orderId.trim()
    }

    if (typeof orderId === "number" && Number.isFinite(orderId)) {
        return String(orderId)
    }

    return undefined
}

export function buildProviderCloseIntent(
    position: Pick<
        Doc<"provider_positions">,
        "instrument" | "side" | "entryPrice" | "metadata" | "providerPositionId" | "positionKey"
    >,
    closure: {
        quantity: number
        fillPrice: number
        metadata?: string
    }
): Record<string, unknown> {
    const metadata = {
        ...readMetadataRecord(position.metadata),
        ...parseJson<Record<string, unknown>>(closure.metadata),
        action: "close",
        providerReconciledClose: true,
        providerPositionId: position.providerPositionId,
        providerPositionKey: position.positionKey,
        entryPrice: position.entryPrice,
        positionSide: position.side,
        estimatedPrice: closure.fillPrice,
    }

    return {
        instrument: position.instrument,
        side: position.side === "long" ? "sell" : "buy",
        quantity: closure.quantity,
        orderType: "market",
        timeInForce: "ioc",
        metadata,
    }
}

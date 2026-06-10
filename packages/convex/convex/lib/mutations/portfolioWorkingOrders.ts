import type { Doc, Id } from "../../_generated/dataModel"
import {
    getOrderIdentityCandidates,
    isCanonicalExecutionOrderId,
    isTerminalOrderStatus,
} from "@valiq-trading/core"
import { appendOrderTransition, patchOrderRowFromDoc, upsertOrderRow } from "./orders"
import type {
    OrderDoc,
    PortfolioMutationCtx,
    ProviderWorkingOrderInput,
    ResolvedOwnership,
    StrategyDoc,
} from "./portfolioTypes"
import {
    readMetadataRecord,
} from "./portfolioUtils"
import { resolveLatestRunIdForStrategy } from "./portfolioOrderRuns"

export function buildActiveOrderLookup(activeOrders: OrderDoc[]): Map<string, OrderDoc> {
    const lookup = new Map<string, OrderDoc>()

    for (const order of activeOrders) {
        for (const orderId of getOrderIdentityCandidates(order)) {
            lookup.set(orderId, order)
        }
    }

    return lookup
}

export async function importCanonicalProviderProtectionOrder(
    ctx: PortfolioMutationCtx,
    args: {
        app: Doc<"strategies">["app"]
        venue: string
        order: ProviderWorkingOrderInput
        ownership: ResolvedOwnership
        strategyMap: Map<string, StrategyDoc>
        latestRunIdsByStrategy: Map<string, Id<"strategy_runs"> | undefined>
        updatedAt: number
    }
): Promise<{ runId: Id<"strategy_runs">; action: Doc<"orders">["action"]; venue: string } | undefined> {
    if (args.app !== "okx-swap" || args.ownership.ownershipStatus !== "owned" || !args.ownership.strategyId) {
        return undefined
    }

    const metadata = readMetadataRecord(args.order.metadata)
    if (metadata?.kind !== "protection") {
        return undefined
    }

    const strategy = args.strategyMap.get(String(args.ownership.strategyId))
    if (!strategy) {
        return undefined
    }

    const providerClientOrderId = readProviderClientOrderId(args.order)
    const canonicalOrderId = resolveCanonicalProviderProtectionOrderId(args.order)
    if (!canonicalOrderId) {
        return undefined
    }

    const existingOrder = await ctx.db
        .query("orders")
        .withIndex("by_order_id", (q) => q.eq("orderId", canonicalOrderId))
        .first()
    if (existingOrder) {
        return {
            runId: existingOrder.runId,
            action: existingOrder.action,
            venue: existingOrder.venue,
        }
    }

    const strategyKey = String(args.ownership.strategyId)
    const runId = args.latestRunIdsByStrategy.has(strategyKey)
        ? args.latestRunIdsByStrategy.get(strategyKey)
        : await resolveLatestRunIdForStrategy(ctx, args.ownership.strategyId)
    args.latestRunIdsByStrategy.set(strategyKey, runId)
    if (!runId) {
        return undefined
    }

    const intent = buildProviderProtectionIntent(args.order, metadata)
    await upsertOrderRow(ctx, {
        orderId: canonicalOrderId,
        canonicalOrderId,
        providerOrderId: args.order.orderId,
        providerClientOrderId,
        providerOrderAliases: [],
        submitAttemptId: undefined,
        submitAttemptSequence: undefined,
        commitOutcome: "accepted",
        signedOrderFingerprint: readSignedOrderFingerprint(args.order),
        signedOrderMetadata: undefined,
        runId,
        strategyId: args.ownership.strategyId,
        venue: args.venue,
        instrument: args.order.instrument,
        status: args.order.status,
        action: "close",
        quantity: args.order.quantity,
        filledQuantity: args.order.filledQuantity,
        remainingQuantity: args.order.remainingQuantity,
        avgFillPrice: args.order.avgFillPrice,
        submittedAt: args.order.submittedAt,
        updatedAt: args.order.updatedAt,
        intent,
        metadata: {
            providerImportedWorkingOrder: true,
            providerOrderKind: "protection",
            providerMetadata: metadata,
        },
        lastTransitionSequence: 0,
        polling: {
            pollIntervalMs: 5_000,
            timeoutMs: 120_000,
            startedAt: args.order.submittedAt,
            lastCheckedAt: args.updatedAt,
            nextCheckAt: args.updatedAt + 5_000,
        },
    })

    await appendOrderTransition(ctx, {
        orderId: canonicalOrderId,
        runId,
        strategyId: args.ownership.strategyId,
        type: "submission",
        status: args.order.status,
        reason: "Provider reconciliation imported a live OKX protection algo order as canonical working-order state",
        details: {
            providerOrderId: args.order.orderId,
            providerMetadata: metadata,
        },
        timestamp: args.order.submittedAt,
    })

    await ctx.db.insert("trade_events", {
        runId,
        strategyId: args.ownership.strategyId,
        app: args.app,
        eventType: "submission",
        payload: JSON.stringify({
            providerImportedWorkingOrder: true,
            result: {
                orderId: canonicalOrderId,
                providerOrderId: args.order.orderId,
                status: args.order.status,
                filledQuantity: args.order.filledQuantity,
                fillPrice: args.order.avgFillPrice,
                timestamp: args.order.updatedAt,
            },
            intent,
        }),
        timestamp: args.order.submittedAt,
    })

    return {
        runId,
        action: "close",
        venue: args.venue,
    }
}

export function buildProviderProtectionIntent(
    order: {
        instrument: string
        side?: "buy" | "sell"
        quantity: number
        limitPrice?: number
        stopPrice?: number
    },
    metadata: Record<string, unknown> | undefined
): Record<string, unknown> {
    return {
        instrument: order.instrument,
        side: order.side ?? "sell",
        quantity: order.quantity,
        orderType: resolveProviderProtectionOrderType(order),
        limitPrice: order.limitPrice,
        stopPrice: order.stopPrice,
        timeInForce: "gtc",
        metadata: {
            action: "close",
            providerProtectionOrder: true,
            protectionOrderType: metadata?.orderType,
            stopLoss: order.stopPrice,
            takeProfit: order.limitPrice,
            providerMetadata: metadata,
        },
    }
}

export function resolveProviderProtectionOrderType(order: {
    limitPrice?: number
    stopPrice?: number
}): "limit" | "stop" | "stop_limit" {
    if (order.limitPrice !== undefined && order.stopPrice !== undefined) {
        return "stop_limit"
    }

    return order.stopPrice !== undefined ? "stop" : "limit"
}

export function resolveCanonicalProviderProtectionOrderId(
    order: Pick<ProviderWorkingOrderInput, "providerClientOrderId" | "metadata">
): string | undefined {
    const providerClientOrderId = readProviderClientOrderId(order)
    return isCanonicalExecutionOrderId(providerClientOrderId)
        ? providerClientOrderId
        : undefined
}

export function resolveLiveWorkingOrderMatch(args: {
    app: Doc<"strategies">["app"]
    liveOrder: ProviderWorkingOrderInput
    activeOrders: OrderDoc[]
    activeOrdersById: Map<string, OrderDoc>
    matchedActiveOrderIds: Set<string>
}): OrderDoc | undefined {
    const directMatch = args.activeOrdersById.get(args.liveOrder.orderId)
    if (directMatch && !args.matchedActiveOrderIds.has(directMatch.orderId)) {
        return directMatch
    }

    const metadataMatchId = readProviderClientOrderId(args.liveOrder) ?? readSignedOrderFingerprint(args.liveOrder)
    if (!metadataMatchId) {
        return undefined
    }

    const metadataMatch = args.activeOrdersById.get(metadataMatchId)
    return metadataMatch && !args.matchedActiveOrderIds.has(metadataMatch.orderId)
        ? metadataMatch
        : undefined
}

export function hasUnresolvedLiveWorkingOrderGap(
    order: OrderDoc,
    unresolvedWorkingOrders: Array<{
        orderId: string
        instrument: string
        quantity: number
        remainingQuantity: number
        side?: "buy" | "sell"
        limitPrice?: number
        stopPrice?: number
        metadata?: string
    }>
): boolean {
    const identifiers = new Set(getOrderIdentityCandidates(order))
    return unresolvedWorkingOrders.some((liveOrder) => {
        const liveIdentifiers = [
            liveOrder.orderId,
            readProviderClientOrderId(liveOrder),
            readSignedOrderFingerprint(liveOrder),
        ].filter((value): value is string => Boolean(value))
        return liveIdentifiers.some((identifier) => identifiers.has(identifier))
    })
}

export async function applyProviderWorkingOrderUpdate(
    ctx: PortfolioMutationCtx,
    args: {
        order: OrderDoc
        liveOrder: Pick<
            ProviderWorkingOrderInput,
            "orderId" |
            "status" |
            "filledQuantity" |
            "remainingQuantity" |
            "avgFillPrice" |
            "updatedAt" |
            "metadata"
        >
        updatedAt: number
    }
): Promise<void> {
    const order = args.order
    const liveOrder = args.liveOrder
    const previousStatus = order.status
    const nextStatus = liveOrder.status
    const nextFilledQuantity = liveOrder.filledQuantity
    const nextRemainingQuantity = liveOrder.remainingQuantity
    const nextAvgFillPrice = liveOrder.avgFillPrice ?? order.avgFillPrice
    const statusChanged = previousStatus !== nextStatus
    const quantityChanged =
        order.filledQuantity !== nextFilledQuantity ||
        order.remainingQuantity !== nextRemainingQuantity ||
        order.avgFillPrice !== nextAvgFillPrice
    const currentProviderOrderId = order.providerOrderId ?? order.orderId
    const providerOrderIdChanged = currentProviderOrderId !== liveOrder.orderId

    await patchOrderRowFromDoc(ctx, order, {
        providerOrderId: liveOrder.orderId,
        providerClientOrderId: readProviderClientOrderId(liveOrder) ?? order.providerClientOrderId,
        providerOrderAliases: mergeProviderOrderAliases(order, liveOrder.orderId),
        commitOutcome: order.commitOutcome === "commit_unknown" ? "recovered" : order.commitOutcome,
        signedOrderFingerprint: readSignedOrderFingerprint(liveOrder) ?? order.signedOrderFingerprint,
        status: nextStatus,
        filledQuantity: nextFilledQuantity,
        remainingQuantity: nextRemainingQuantity,
        avgFillPrice: nextAvgFillPrice,
        updatedAt: liveOrder.updatedAt,
        polling: {
            ...order.polling,
            lastCheckedAt: args.updatedAt,
            nextCheckAt: isTerminalOrderStatus(nextStatus)
                ? undefined
                : args.updatedAt + order.polling.pollIntervalMs,
            lastError: undefined,
        },
    })

    if (!statusChanged && !quantityChanged && !providerOrderIdChanged) {
        return
    }

    await appendOrderTransition(ctx, {
        orderId: order.orderId,
        runId: order.runId,
        strategyId: order.strategyId,
        type: isTerminalOrderStatus(nextStatus) ? "terminal" : "status_change",
        status: nextStatus,
        previousStatus,
        reason: "Provider reconciliation refreshed the live working-order state",
        details: {
            providerOrderId: liveOrder.orderId,
            previousProviderOrderId: currentProviderOrderId,
            filledQuantity: nextFilledQuantity,
            remainingQuantity: nextRemainingQuantity,
            avgFillPrice: nextAvgFillPrice,
        },
        timestamp: liveOrder.updatedAt,
    })
}

export async function applyClosedOrderInference(
    ctx: PortfolioMutationCtx,
    args: {
        order: OrderDoc
        inferredResolution: {
            status: Doc<"orders">["status"]
            filledQuantity?: number
            remainingQuantity?: number
            avgFillPrice?: number
        }
        updatedAt: number
    }
): Promise<void> {
    const order = args.order
    const previousStatus = order.status
    const nextStatus = args.inferredResolution.status
    const nextFilledQuantity = args.inferredResolution.filledQuantity ?? order.filledQuantity
    const nextRemainingQuantity = args.inferredResolution.remainingQuantity ?? order.remainingQuantity
    const nextAvgFillPrice = args.inferredResolution.avgFillPrice ?? order.avgFillPrice
    const resolutionReason = nextStatus === "filled"
        ? "Provider reconciliation inferred a fill from provider-truth position state after the order left the live working-order book"
        : "Provider reconciliation inferred a cancellation after the order left the live working-order book without fill evidence"

    await patchOrderRowFromDoc(ctx, order, {
        commitOutcome: order.commitOutcome === "commit_unknown" ? "recovered" : order.commitOutcome,
        status: nextStatus,
        filledQuantity: nextFilledQuantity,
        remainingQuantity: nextRemainingQuantity,
        avgFillPrice: nextAvgFillPrice,
        updatedAt: args.updatedAt,
        polling: {
            ...order.polling,
            lastCheckedAt: args.updatedAt,
            nextCheckAt: undefined,
            timedOutAt: undefined,
            lastError: nextStatus === "cancelled"
                ? resolutionReason
                : undefined,
        },
    })

    await appendOrderTransition(ctx, {
        orderId: order.orderId,
        runId: order.runId,
        strategyId: order.strategyId,
        type: "terminal",
        status: nextStatus,
        previousStatus,
        reason: resolutionReason,
        details: {
            providerOrderId: order.providerOrderId ?? order.orderId,
            filledQuantity: nextFilledQuantity,
            remainingQuantity: nextRemainingQuantity,
            avgFillPrice: nextAvgFillPrice,
        },
        timestamp: args.updatedAt,
    })
}

export function mergeProviderOrderAliases(
    order: Pick<OrderDoc, "orderId" | "providerOrderId" | "providerOrderAliases">,
    nextProviderOrderId: string
): string[] {
    const aliases = new Set<string>(order.providerOrderAliases ?? [])

    if (
        (order.providerOrderId ?? order.orderId) !== order.orderId &&
        (order.providerOrderId ?? order.orderId) !== nextProviderOrderId
    ) {
        aliases.add(order.providerOrderId ?? order.orderId)
    }

    aliases.delete(order.orderId)
    aliases.delete(nextProviderOrderId)

    return Array.from(aliases).sort((left, right) => left.localeCompare(right))
}

export function readProviderClientOrderId(
    order: Pick<ProviderWorkingOrderInput, "providerClientOrderId" | "metadata"> | Pick<ProviderWorkingOrderInput, "metadata">
): string | undefined {
    if ("providerClientOrderId" in order && order.providerClientOrderId) {
        return order.providerClientOrderId
    }

    const metadata = readMetadataRecord(order.metadata)
    const providerClientOrderId = metadata?.providerClientOrderId ?? metadata?.clientOrderId ?? metadata?.client_order_id ?? metadata?.clOrdId
    return typeof providerClientOrderId === "string" && providerClientOrderId.trim()
        ? providerClientOrderId.trim()
        : undefined
}

export function readSignedOrderFingerprint(
    order: Pick<ProviderWorkingOrderInput, "signedOrderFingerprint" | "metadata"> | Pick<ProviderWorkingOrderInput, "metadata">
): string | undefined {
    if ("signedOrderFingerprint" in order && order.signedOrderFingerprint) {
        return order.signedOrderFingerprint
    }

    const metadata = readMetadataRecord(order.metadata)
    const fingerprint = metadata?.signedOrderFingerprint
    return typeof fingerprint === "string" && fingerprint.trim()
        ? fingerprint.trim()
        : undefined
}

export async function listActiveOrdersForApp(
    ctx: PortfolioMutationCtx,
    strategies: StrategyDoc[]
): Promise<OrderDoc[]> {
    const activeOrders: OrderDoc[] = []

    for (const strategy of strategies) {
        const [pending, partiallyFilled] = await Promise.all([
            ctx.db
                .query("orders")
                .withIndex("by_strategy_status", (q) =>
                    q.eq("strategyId", strategy._id).eq("status", "pending")
                )
                .collect(),
            ctx.db
                .query("orders")
                .withIndex("by_strategy_status", (q) =>
                    q.eq("strategyId", strategy._id).eq("status", "partially_filled")
                )
                .collect(),
        ])

        activeOrders.push(...pending, ...partiallyFilled)
    }

    return activeOrders
}

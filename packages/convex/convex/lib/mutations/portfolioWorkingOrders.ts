import type { Doc, Id } from "../../_generated/dataModel"
import {
    getOrderIdentityCandidates,
    isTerminalOrderStatus,
} from "@valiq-trading/core"
import { appendOrderTransition, upsertOrderRow } from "./orders"
import type {
    OrderDoc,
    PortfolioMutationCtx,
    ProviderWorkingOrderInput,
    ResolvedOwnership,
    StrategyDoc,
} from "./portfolioTypes"
import {
    almostEqual,
    readFiniteNumber,
    readMetadataRecord,
    readOrderIntentRecord,
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

    const existingOrder = await ctx.db
        .query("orders")
        .withIndex("by_order_id", (q) => q.eq("orderId", args.order.orderId))
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
        orderId: args.order.orderId,
        providerOrderId: args.order.orderId,
        providerOrderAliases: [],
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
        orderId: args.order.orderId,
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
                orderId: args.order.orderId,
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

    if (args.app !== "mt5") {
        return undefined
    }

    const candidates = args.activeOrders.filter((order) =>
        !args.matchedActiveOrderIds.has(order.orderId) &&
        matchesMT5WorkingOrderContinuity(order, args.liveOrder)
    )

    return candidates.length === 1 ? candidates[0] : undefined
}

export function hasUnresolvedLiveWorkingOrderGap(
    order: OrderDoc,
    unresolvedWorkingOrders: Array<{
        instrument: string
        quantity: number
        remainingQuantity: number
        side?: "buy" | "sell"
        limitPrice?: number
        stopPrice?: number
        metadata?: string
    }>
): boolean {
    return unresolvedWorkingOrders.some((liveOrder) => matchesMT5WorkingOrderContinuity(order, liveOrder))
}

export function matchesMT5WorkingOrderContinuity(
    order: Pick<
        OrderDoc,
        "orderId" |
        "providerOrderId" |
        "providerOrderAliases" |
        "venue" |
        "instrument" |
        "status" |
        "action" |
        "quantity" |
        "filledQuantity" |
        "remainingQuantity" |
        "intent"
    >,
    liveOrder: {
        instrument: string
        quantity: number
        remainingQuantity: number
        side?: "buy" | "sell"
        limitPrice?: number
        stopPrice?: number
        metadata?: string
    }
): boolean {
    if (order.venue !== "mt5") {
        return false
    }

    if (order.action !== "entry" && order.action !== "adjustment") {
        return false
    }

    if (order.instrument !== liveOrder.instrument) {
        return false
    }

    const intent = readOrderIntentRecord(order.intent)
    const intentMetadata = readOrderIntentRecord(intent?.metadata)
    const intentSide = intent?.side === "buy" || intent?.side === "sell"
        ? intent.side
        : undefined
    const intentLimitPrice = readFiniteNumber(intent?.limitPrice)
    const intentStopLoss = readFiniteNumber(intentMetadata?.stopLoss)
    const intentTakeProfit = readFiniteNumber(intentMetadata?.takeProfit)
    const liveMetadata = readMetadataRecord(liveOrder.metadata)
    const liveTakeProfit = readFiniteNumber(liveMetadata?.takeProfit)

    if (liveOrder.side && intentSide !== liveOrder.side) {
        return false
    }

    if (!almostEqual(order.quantity, liveOrder.quantity)) {
        return false
    }

    if (!almostEqual(order.remainingQuantity, liveOrder.remainingQuantity)) {
        return false
    }

    if (liveOrder.limitPrice !== undefined && intentLimitPrice !== undefined && !almostEqual(intentLimitPrice, liveOrder.limitPrice)) {
        return false
    }

    if (liveOrder.stopPrice !== undefined && intentStopLoss !== undefined && !almostEqual(intentStopLoss, liveOrder.stopPrice)) {
        return false
    }

    if (liveTakeProfit !== undefined && intentTakeProfit !== undefined && !almostEqual(intentTakeProfit, liveTakeProfit)) {
        return false
    }

    return true
}

export async function applyProviderWorkingOrderUpdate(
    ctx: PortfolioMutationCtx,
    args: {
        order: OrderDoc
        liveOrder: Pick<ProviderWorkingOrderInput, "orderId" | "status" | "filledQuantity" | "remainingQuantity" | "avgFillPrice" | "updatedAt">
        updatedAt: number
    }
): Promise<void> {
    const order = args.order
    const liveOrder = args.liveOrder
    const nextProviderOrderAliases = mergeProviderOrderAliases(order, liveOrder.orderId)
    const nextStatus = liveOrder.status
    const nextFilledQuantity = liveOrder.filledQuantity
    const nextRemainingQuantity = liveOrder.remainingQuantity
    const nextAvgFillPrice = liveOrder.avgFillPrice ?? order.avgFillPrice
    const statusChanged = order.status !== nextStatus
    const quantityChanged =
        order.filledQuantity !== nextFilledQuantity ||
        order.remainingQuantity !== nextRemainingQuantity ||
        order.avgFillPrice !== nextAvgFillPrice
    const currentProviderOrderId = order.providerOrderId ?? order.orderId
    const providerOrderIdChanged = currentProviderOrderId !== liveOrder.orderId

    await upsertOrderRow(ctx, {
        orderId: order.orderId,
        providerOrderId: liveOrder.orderId,
        providerOrderAliases: nextProviderOrderAliases,
        runId: order.runId,
        strategyId: order.strategyId,
        venue: order.venue,
        instrument: order.instrument,
        status: nextStatus,
        action: order.action,
        quantity: order.quantity,
        filledQuantity: nextFilledQuantity,
        remainingQuantity: nextRemainingQuantity,
        avgFillPrice: nextAvgFillPrice,
        submittedAt: order.submittedAt,
        updatedAt: liveOrder.updatedAt,
        intent: order.intent,
        metadata: order.metadata,
        lastTransitionSequence: order.lastTransitionSequence,
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
        previousStatus: order.status,
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
    const nextStatus = args.inferredResolution.status
    const nextFilledQuantity = args.inferredResolution.filledQuantity ?? order.filledQuantity
    const nextRemainingQuantity = args.inferredResolution.remainingQuantity ?? order.remainingQuantity
    const nextAvgFillPrice = args.inferredResolution.avgFillPrice ?? order.avgFillPrice
    const resolutionReason = nextStatus === "filled"
        ? "Provider reconciliation inferred a fill from provider-truth position state after the order left the live working-order book"
        : "Provider reconciliation inferred a cancellation after the order left the live working-order book without fill evidence"

    await upsertOrderRow(ctx, {
        orderId: order.orderId,
        providerOrderId: order.providerOrderId ?? order.orderId,
        providerOrderAliases: order.providerOrderAliases ?? [],
        runId: order.runId,
        strategyId: order.strategyId,
        venue: order.venue,
        instrument: order.instrument,
        status: nextStatus,
        action: order.action,
        quantity: order.quantity,
        filledQuantity: nextFilledQuantity,
        remainingQuantity: nextRemainingQuantity,
        avgFillPrice: nextAvgFillPrice,
        submittedAt: order.submittedAt,
        updatedAt: args.updatedAt,
        intent: order.intent,
        metadata: order.metadata,
        lastTransitionSequence: order.lastTransitionSequence,
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
        previousStatus: order.status,
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

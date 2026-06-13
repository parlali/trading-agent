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
        providerOrderAliases: mergeInputProviderOrderAliases(args.order),
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
            "providerOrderAliases" |
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
    const nextIntent = buildProviderWorkingOrderIntent(order, liveOrder)
    const statusChanged = previousStatus !== nextStatus
    const quantityChanged =
        order.filledQuantity !== nextFilledQuantity ||
        order.remainingQuantity !== nextRemainingQuantity ||
        order.avgFillPrice !== nextAvgFillPrice
    const currentProviderOrderId = order.providerOrderId ?? order.orderId
    const providerOrderIdChanged = currentProviderOrderId !== liveOrder.orderId
    const intentChanged = nextIntent !== order.intent

    await patchOrderRowFromDoc(ctx, order, {
        providerOrderId: liveOrder.orderId,
        providerClientOrderId: readProviderClientOrderId(liveOrder) ?? order.providerClientOrderId,
        providerOrderAliases: mergeProviderOrderAliases(order, liveOrder.orderId, liveOrder.providerOrderAliases),
        commitOutcome: order.commitOutcome === "commit_unknown" ? "recovered" : order.commitOutcome,
        signedOrderFingerprint: readSignedOrderFingerprint(liveOrder) ?? order.signedOrderFingerprint,
        status: nextStatus,
        filledQuantity: nextFilledQuantity,
        remainingQuantity: nextRemainingQuantity,
        avgFillPrice: nextAvgFillPrice,
        intent: nextIntent,
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

    if (isProviderFillStatus(nextStatus) && !hasProviderAccountingMetadata({
        ...order,
        intent: nextIntent,
        avgFillPrice: nextAvgFillPrice,
    })) {
        await recordInferredFillAccountingFault(ctx, {
            order: {
                ...order,
                providerOrderId: liveOrder.orderId,
                providerClientOrderId: readProviderClientOrderId(liveOrder) ?? order.providerClientOrderId,
                providerOrderAliases: mergeProviderOrderAliases(order, liveOrder.orderId, liveOrder.providerOrderAliases),
                intent: nextIntent,
                avgFillPrice: nextAvgFillPrice,
            },
            updatedAt: args.updatedAt,
            reason: "Provider reconciliation refreshed a filled working order without provider accounting metadata",
        })
    }

    if (!statusChanged && !quantityChanged && !providerOrderIdChanged && !intentChanged) {
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
    const intent = nextStatus === "filled"
        ? buildInferredFillIntent(order)
        : order.intent

    await patchOrderRowFromDoc(ctx, order, {
        commitOutcome: order.commitOutcome === "commit_unknown" ? "recovered" : order.commitOutcome,
        status: nextStatus,
        filledQuantity: nextFilledQuantity,
        remainingQuantity: nextRemainingQuantity,
        avgFillPrice: nextAvgFillPrice,
        intent,
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

    if (nextStatus === "filled" && !hasProviderAccountingMetadata(order)) {
        await recordInferredFillAccountingFault(ctx, {
            order,
            updatedAt: args.updatedAt,
        })
    }

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

function buildInferredFillIntent(order: OrderDoc): Record<string, unknown> {
    const intent = readOrderIntentRecord(order.intent) ?? {}
    return {
        ...intent,
        metadata: {
            ...(intent.metadata && typeof intent.metadata === "object" ? intent.metadata as Record<string, unknown> : {}),
            providerReconciliationInferredFill: true,
            providerAccountingBackfillMissing: !hasProviderAccountingMetadata(order),
        },
    }
}

function buildProviderWorkingOrderIntent(
    order: OrderDoc,
    liveOrder: Pick<ProviderWorkingOrderInput, "status" | "metadata">
): OrderDoc["intent"] {
    if (!isProviderFillStatus(liveOrder.status)) {
        return order.intent
    }

    const metadata = readMetadataRecord(liveOrder.metadata)
    if (!metadata) {
        return order.intent
    }

    const intent = readOrderIntentRecord(order.intent) ?? {}
    const previousMetadata = intent.metadata && typeof intent.metadata === "object"
        ? intent.metadata as Record<string, unknown>
        : {}

    return {
        ...intent,
        metadata: {
            ...previousMetadata,
            ...metadata,
        },
    }
}

function isProviderFillStatus(status: Doc<"orders">["status"]): boolean {
    return status === "filled" || status === "partially_filled"
}

export function hasProviderAccountingMetadata(order: OrderDoc): boolean {
    const intent = readOrderIntentRecord(order.intent)
    const metadata = intent?.metadata && typeof intent.metadata === "object"
        ? intent.metadata as Record<string, unknown>
        : undefined

    if (metadata?.providerAccountingMissing === true) {
        return false
    }

    const hasFillPnl = hasFiniteMetadataNumber(metadata?.fillPnl)

    if (order.action === "close") {
        return hasFillPnl ||
            hasFiniteMetadataNumber(metadata?.fillPrice) ||
            (typeof order.avgFillPrice === "number" && Number.isFinite(order.avgFillPrice) && order.avgFillPrice > 0)
    }

    return hasFillPnl ||
        hasFiniteMetadataNumber(metadata?.fee) ||
        typeof metadata?.providerAccountingSource === "string"
}

function hasFiniteMetadataNumber(value: unknown): boolean {
    if (typeof value === "number") {
        return Number.isFinite(value)
    }

    if (typeof value === "string" && value.trim()) {
        return Number.isFinite(Number(value))
    }

    return false
}

async function recordInferredFillAccountingFault(
    ctx: PortfolioMutationCtx,
    args: {
        order: OrderDoc
        updatedAt: number
        reason?: string
    }
): Promise<void> {
    if (!args.order.accountId) {
        throw new Error(`Cannot record inferred fill accounting fault for order without accountId: ${args.order.orderId}`)
    }

    const message = args.reason ?? `Provider reconciliation inferred a filled ${args.order.action} order without provider accounting metadata`
    const existing = await ctx.db
        .query("execution_safety_faults")
        .withIndex("by_strategy_blocked", (q) => q.eq("strategyId", args.order.strategyId).eq("blocked", true))
        .collect()
    if (existing.some((fault) =>
        fault.category === "accounting_mismatch" &&
        fault.canonicalOrderId === args.order.orderId &&
        fault.message === message
    )) {
        return
    }

    await ctx.db.insert("execution_safety_faults", {
        strategyId: args.order.strategyId,
        app: args.order.app ?? args.order.venue as Doc<"strategies">["app"],
        accountId: args.order.accountId,
        instrument: args.order.instrument,
        category: "accounting_mismatch",
        message,
        providerPayload: JSON.stringify({
            orderId: args.order.orderId,
            providerOrderId: args.order.providerOrderId,
            action: args.order.action,
        }),
        canonicalOrderId: args.order.orderId,
        providerOrderId: args.order.providerOrderId,
        providerClientOrderId: args.order.providerClientOrderId,
        providerOrderAliases: args.order.providerOrderAliases,
        runId: args.order.runId,
        venue: args.order.venue,
        blocked: true,
        occurredAt: args.updatedAt,
        resolvedAt: undefined,
        resolutionNote: undefined,
    })
}

export function mergeProviderOrderAliases(
    order: Pick<OrderDoc, "orderId" | "providerOrderId" | "providerOrderAliases">,
    nextProviderOrderId: string,
    nextAliases: string[] = []
): string[] {
    const aliases = new Set<string>([...(order.providerOrderAliases ?? []), ...nextAliases])

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

function mergeInputProviderOrderAliases(order: Pick<ProviderWorkingOrderInput, "orderId" | "providerOrderId" | "providerClientOrderId" | "providerOrderAliases">): string[] {
    const aliases = new Set<string>([
        ...(order.providerOrderAliases ?? []),
        order.providerOrderId,
        order.providerClientOrderId,
    ].filter((value): value is string => Boolean(value)))

    aliases.delete(order.orderId)
    if (order.providerClientOrderId) {
        aliases.delete(order.providerClientOrderId)
    }

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

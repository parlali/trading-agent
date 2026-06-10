import type { Doc, Id } from "../../_generated/dataModel"
import type {
    PortfolioMutationCtx,
    ProviderPositionClosureInput,
} from "./portfolioTypes"
import { appendOrderTransition, patchOrderRowFromDoc, upsertOrderRow } from "./orders"
import { parseJson, readMetadataRecord, readOrderIntentRecord } from "./portfolioUtils"
import {
    buildProviderCloseOrderId,
    isRetiredProviderCloseOrder,
    isSyntheticProviderCloseOrder,
    readOrderIntentMetadata,
    resolveProviderCloseOrderProviderId,
    type ProviderClosePositionCandidate,
} from "./portfolioCloseIdentity"

export async function attachClosureToCanonicalCloseOrder(
    ctx: PortfolioMutationCtx,
    args: {
        order: Doc<"orders">
        position?: ProviderClosePositionCandidate
        closure: ProviderPositionClosureInput
        updatedAt: number
    }
): Promise<void> {
    if (args.order.status !== "filled" || canonicalCloseNeedsProviderClosureAttach(args.order, args.closure)) {
        await attachProviderClosureToCanonicalCloseOrder(ctx, args)
    }

    const duplicateSynthetic = await resolveExistingProviderCloseOrder(ctx, {
        syntheticOrderId: args.position && args.order.app
            ? buildProviderCloseOrderId(args.order.app, args.position, args.closure)
            : undefined,
        providerOrderId: resolveProviderCloseOrderProviderId(args.closure),
    })
    if (duplicateSynthetic && duplicateSynthetic.orderId !== args.order.orderId && duplicateSynthetic.status !== "cancelled") {
        await retireDuplicateProviderCloseOrder(ctx, {
            order: duplicateSynthetic,
            canonicalOrderId: args.order.orderId,
            closure: args.closure,
            updatedAt: args.updatedAt,
        })
    }
}

export async function importSyntheticProviderClose(
    ctx: PortfolioMutationCtx,
    args: {
        app: Doc<"strategies">["app"]
        position: ProviderClosePositionCandidate
        closure: ProviderPositionClosureInput
        runId: Id<"strategy_runs">
        updatedAt: number
    }
): Promise<void> {
    const { app, position, closure } = args
    const syntheticOrderId = buildProviderCloseOrderId(app, position, closure)
    const providerOrderId = resolveProviderCloseOrderProviderId(closure)
    const existingOrder = await resolveExistingProviderCloseOrder(ctx, {
        syntheticOrderId,
        providerOrderId,
    })

    if (existingOrder && isRetiredProviderCloseOrder(existingOrder)) {
        return
    }

    const orderId = existingOrder?.orderId ?? syntheticOrderId
    const runId = existingOrder?.runId ?? args.runId

    await upsertOrderRow(ctx, {
        orderId,
        canonicalOrderId: existingOrder?.canonicalOrderId ?? orderId,
        providerOrderId: providerOrderId ?? orderId,
        providerClientOrderId: undefined,
        providerOrderAliases: [],
        submitAttemptId: undefined,
        submitAttemptSequence: undefined,
        commitOutcome: "accepted",
        signedOrderFingerprint: undefined,
        signedOrderMetadata: undefined,
        runId,
        strategyId: position.strategyId,
        venue: app,
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

    if ((existingOrder?.lastTransitionSequence ?? 0) > 0) {
        return
    }

    await appendOrderTransition(ctx, {
        orderId,
        runId,
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
        runId,
        strategyId: position.strategyId,
        app,
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

export async function repairMT5EntryOrderFromProviderClosure(
    ctx: PortfolioMutationCtx,
    args: {
        order: Doc<"orders">
        position: ProviderClosePositionCandidate
        closure: ProviderPositionClosureInput
        updatedAt: number
    }
): Promise<void> {
    const previousStatus = args.order.status
    await patchOrderRowFromDoc(ctx, args.order, {
        commitOutcome: args.order.commitOutcome === "accepted" ? "accepted" : "recovered",
        status: "filled",
        filledQuantity: args.position.quantity,
        remainingQuantity: Math.max(args.order.quantity - args.position.quantity, 0),
        avgFillPrice: args.position.entryPrice,
        updatedAt: args.closure.closedAt,
        polling: {
            ...args.order.polling,
            lastCheckedAt: args.updatedAt,
            nextCheckAt: undefined,
            timedOutAt: undefined,
            lastError: undefined,
        },
    })

    await appendOrderTransition(ctx, {
        orderId: args.order.orderId,
        runId: args.order.runId,
        strategyId: args.order.strategyId,
        type: "terminal",
        status: "filled",
        previousStatus,
        reason: "Provider closure history proved this MT5 entry order filled before the broker-reported position close",
        details: {
            providerOrderId: args.order.providerOrderId ?? args.order.orderId,
            providerPositionId: args.closure.providerPositionId,
            filledQuantity: args.position.quantity,
            avgFillPrice: args.position.entryPrice,
            closeMetadata: parseJson<Record<string, unknown>>(args.closure.metadata),
        },
        timestamp: args.closure.closedAt,
    })
}

export function buildProviderCloseIntent(
    position: Pick<
        ProviderClosePositionCandidate,
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

async function attachProviderClosureToCanonicalCloseOrder(
    ctx: PortfolioMutationCtx,
    args: {
        order: Doc<"orders">
        position?: ProviderClosePositionCandidate
        closure: ProviderPositionClosureInput
        updatedAt: number
    }
): Promise<void> {
    const previousStatus = args.order.status
    const promoteToFilled = previousStatus !== "filled"
    await patchOrderRowFromDoc(ctx, args.order, {
        status: "filled",
        filledQuantity: promoteToFilled ? args.closure.quantity : args.order.filledQuantity,
        remainingQuantity: promoteToFilled ? 0 : args.order.remainingQuantity,
        avgFillPrice: promoteToFilled
            ? args.closure.fillPrice
            : args.order.avgFillPrice ?? args.closure.fillPrice,
        updatedAt: args.closure.closedAt,
        intent: buildCanonicalCloseIntentWithProviderClosure(args.order, args.position, args.closure),
        polling: {
            ...args.order.polling,
            lastCheckedAt: args.updatedAt,
            nextCheckAt: undefined,
            timedOutAt: undefined,
        },
    })

    await appendOrderTransition(ctx, {
        orderId: args.order.orderId,
        runId: args.order.runId,
        strategyId: args.order.strategyId,
        type: promoteToFilled ? "terminal" : "status_change",
        status: "filled",
        previousStatus,
        reason: promoteToFilled
            ? "Provider closure history proved this canonical close order filled and attached broker-reported realized PnL"
            : "Provider closure history attached broker-reported realized PnL to this canonical close order",
        details: {
            providerPositionId: args.closure.providerPositionId,
            fillPrice: args.closure.fillPrice,
            quantity: args.closure.quantity,
            metadata: parseJson<Record<string, unknown>>(args.closure.metadata),
        },
        timestamp: args.closure.closedAt,
    })
}

function canonicalCloseNeedsProviderClosureAttach(
    order: Doc<"orders">,
    closure: ProviderPositionClosureInput
): boolean {
    const metadata = readOrderIntentMetadata(order)
    if (metadata?.providerReconciledClose !== true) {
        return true
    }

    const closureMetadata = parseJson<Record<string, unknown>>(closure.metadata)
    const closurePnl = typeof closureMetadata?.fillPnl === "number"
        ? closureMetadata.fillPnl
        : closureMetadata?.profit
    return typeof closurePnl === "number" && metadata.fillPnl !== closurePnl
}

async function resolveExistingProviderCloseOrder(
    ctx: PortfolioMutationCtx,
    args: {
        syntheticOrderId?: string
        providerOrderId?: string
    }
): Promise<Doc<"orders"> | null> {
    if (args.syntheticOrderId) {
        const bySyntheticOrderId = await ctx.db
            .query("orders")
            .withIndex("by_order_id", (q) => q.eq("orderId", args.syntheticOrderId!))
            .first()
        if (bySyntheticOrderId) {
            return bySyntheticOrderId
        }
    }

    if (!args.providerOrderId) {
        return null
    }

    const providerOrderId = args.providerOrderId
    const byProviderOrderId = await ctx.db
        .query("orders")
        .withIndex("by_provider_order_id", (q) => q.eq("providerOrderId", providerOrderId))
        .first()

    return byProviderOrderId && isSyntheticProviderCloseOrder(byProviderOrderId)
        ? byProviderOrderId
        : null
}

function buildCanonicalCloseIntentWithProviderClosure(
    order: Doc<"orders">,
    position: ProviderClosePositionCandidate | undefined,
    closure: ProviderPositionClosureInput
): Record<string, unknown> {
    const intent = readOrderIntentRecord(order.intent) ?? {}
    const currentMetadata = readOrderIntentMetadata(order) ?? {}
    const metadata = {
        ...currentMetadata,
        ...readMetadataRecord(position?.metadata),
        ...parseJson<Record<string, unknown>>(closure.metadata),
        providerReconciledClose: true,
        providerPositionId: currentMetadata.providerPositionId ?? position?.providerPositionId,
        providerPositionKey: currentMetadata.providerPositionKey ?? position?.positionKey,
        entryPrice: currentMetadata.entryPrice ?? position?.entryPrice,
        positionSide: currentMetadata.positionSide ?? position?.side ?? closure.side,
        estimatedPrice: closure.fillPrice,
    }

    return {
        ...intent,
        metadata,
    }
}

async function retireDuplicateProviderCloseOrder(
    ctx: PortfolioMutationCtx,
    args: {
        order: Doc<"orders">
        canonicalOrderId: string
        closure: ProviderPositionClosureInput
        updatedAt: number
    }
): Promise<void> {
    const previousStatus = args.order.status
    await patchOrderRowFromDoc(ctx, args.order, {
        canonicalOrderId: args.canonicalOrderId,
        status: "cancelled",
        filledQuantity: 0,
        remainingQuantity: args.order.quantity,
        updatedAt: args.updatedAt,
        intent: buildRetiredProviderCloseIntent(args.order, args.canonicalOrderId),
        polling: {
            ...args.order.polling,
            lastCheckedAt: args.updatedAt,
            nextCheckAt: undefined,
            timedOutAt: undefined,
            lastError: "Retired duplicate synthetic provider-close row after broker PnL was attached to the canonical close order",
        },
    })

    await appendOrderTransition(ctx, {
        orderId: args.order.orderId,
        runId: args.order.runId,
        strategyId: args.order.strategyId,
        type: "terminal",
        status: "cancelled",
        previousStatus,
        reason: "Retired duplicate synthetic provider-close row after broker PnL was attached to the canonical close order",
        details: {
            canonicalOrderId: args.canonicalOrderId,
            providerPositionId: args.closure.providerPositionId,
            metadata: parseJson<Record<string, unknown>>(args.closure.metadata),
        },
        timestamp: args.updatedAt,
    })
}

function buildRetiredProviderCloseIntent(
    order: Doc<"orders">,
    canonicalOrderId: string
): Record<string, unknown> {
    const intent = readOrderIntentRecord(order.intent) ?? {}

    return {
        ...intent,
        metadata: {
            ...(readOrderIntentMetadata(order) ?? {}),
            providerReconciledCloseRetired: true,
            providerReconciledDuplicateOfOrderId: canonicalOrderId,
        },
    }
}

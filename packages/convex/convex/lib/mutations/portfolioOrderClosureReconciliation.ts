import type { Doc, Id } from "../../_generated/dataModel"
import type {
    PortfolioMutationCtx,
    ProviderPositionClosureInput,
    StrategyDoc,
} from "./portfolioTypes"
import { appendOrderTransition, upsertOrderRow } from "./orders"
import {
    almostEqual,
    isEntryLikeOrder,
    parseJson,
    readMetadataRecord,
    readOrderIntentRecord,
} from "./portfolioUtils"
import { resolveLatestRunIdForStrategy } from "./portfolioOrderRuns"
import {
    getOrderProviderIdentifiers,
    positionMatchesOrderDirection,
} from "./portfolioOrderInference"

type ProviderClosePositionCandidate = Pick<
    Doc<"provider_positions">,
    "instrument" |
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
    requiresStrongClosureIdentity?: boolean
    sourceOrder?: Doc<"orders">
}

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

    const candidatePositions: ProviderClosePositionCandidate[] = [
        ...args.existingProviderPositions
            .filter((position) =>
                position.ownershipStatus === "owned" &&
                position.strategyId !== undefined &&
                position.expectedExternal !== true &&
                !args.livePositionKeys.has(position.positionKey)
            )
            .map((position) => ({
                ...position,
                strategyId: position.strategyId!,
            })),
        ...await resolveHistoricMT5ProviderCloseCandidates(ctx, args),
    ]
    const latestRunIdsByStrategy = new Map<string, Id<"strategy_runs"> | undefined>()
    const importedClosureKeys = new Set<string>()

    for (const position of candidatePositions) {
        const strategy = args.strategyMap.get(String(position.strategyId))
        if (!strategy) {
            continue
        }

        const runId = position.runId ?? await resolveProviderCloseRunId(ctx, {
            strategyId: position.strategyId,
            latestRunIdsByStrategy,
        })
        if (!runId) {
            continue
        }

        const closure = resolveMatchingPositionClosure(
            position,
            args.positionClosures.filter((candidate) => !importedClosureKeys.has(buildPositionClosureKey(candidate)))
        )
        if (!closure) {
            continue
        }

        if (position.sourceOrder && position.sourceOrder.status !== "filled" && position.sourceOrder.status !== "partially_filled") {
            await repairMT5EntryOrderFromProviderClosure(ctx, {
                order: position.sourceOrder,
                position,
                closure,
                updatedAt: args.updatedAt,
            })
        }

        const syntheticOrderId = buildProviderCloseOrderId(args.app, position, closure)
        const providerOrderId = resolveProviderCloseOrderProviderId(closure)
        const canonicalCloseOrder = await resolveExistingCanonicalCloseOrderForClosure(ctx, {
            strategyId: position.strategyId,
            closure,
        })
        const existingOrder = await resolveExistingProviderCloseOrder(ctx, {
            syntheticOrderId,
            providerOrderId,
        })

        if (existingOrder && isRetiredProviderCloseOrder(existingOrder) && !canonicalCloseOrder) {
            importedClosureKeys.add(buildPositionClosureKey(closure))
            continue
        }

        if (canonicalCloseOrder) {
            if (canonicalCloseNeedsProviderClosureAttach(canonicalCloseOrder, closure)) {
                await attachProviderClosureToCanonicalCloseOrder(ctx, {
                    order: canonicalCloseOrder,
                    position,
                    closure,
                    updatedAt: args.updatedAt,
                })
            }
            if (existingOrder && existingOrder.orderId !== canonicalCloseOrder.orderId && existingOrder.status !== "cancelled") {
                await retireDuplicateProviderCloseOrder(ctx, {
                    order: existingOrder,
                    canonicalOrderId: canonicalCloseOrder.orderId,
                    closure,
                    updatedAt: args.updatedAt,
                })
            }
            importedClosureKeys.add(buildPositionClosureKey(closure))
            continue
        }

        const orderId = existingOrder?.orderId ?? syntheticOrderId
        const canonicalOrderId = existingOrder?.canonicalOrderId ?? orderId

        await upsertOrderRow(ctx, {
            orderId,
            canonicalOrderId,
            providerOrderId: providerOrderId ?? orderId,
            providerClientOrderId: undefined,
            providerOrderAliases: [],
            submitAttemptId: undefined,
            submitAttemptSequence: undefined,
            commitOutcome: "accepted",
            signedOrderFingerprint: undefined,
            signedOrderMetadata: undefined,
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
                orderId,
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

        importedClosureKeys.add(buildPositionClosureKey(closure))
    }
}
export function resolveMatchingPositionClosure(
    position: Pick<ProviderClosePositionCandidate, "instrument" | "side" | "quantity" | "syncedAt" | "providerPositionId" | "metadata" | "requiresStrongClosureIdentity">,
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
        hasSharedProviderPositionIdentity(positionIds, buildPositionClosureIdentityCandidates(closure))
    )
    if (strongMatches.length > 0) {
        return strongMatches.sort((left, right) => right.closedAt - left.closedAt)[0]
    }

    if (position.requiresStrongClosureIdentity === true) {
        return undefined
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
    position: Pick<ProviderClosePositionCandidate, "providerPositionId" | "metadata">
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

export function buildPositionClosureIdentityCandidates(
    closure: Pick<ProviderPositionClosureInput, "providerPositionId" | "metadata">
): Set<string> {
    const identifiers = new Set<string>()
    addKnownIdentifier(identifiers, closure.providerPositionId)

    const metadata = parseJson<Record<string, unknown>>(closure.metadata)
    addKnownIdentifier(identifiers, metadata?.ticket)
    addKnownIdentifier(identifiers, metadata?.orderId)
    addKnownIdentifier(identifiers, metadata?.positionId)
    addKnownIdentifier(identifiers, metadata?.providerPositionId)
    return identifiers
}

function hasSharedProviderPositionIdentity(
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

async function resolveProviderCloseRunId(
    ctx: PortfolioMutationCtx,
    args: {
        strategyId: Id<"strategies">
        latestRunIdsByStrategy: Map<string, Id<"strategy_runs"> | undefined>
    }
): Promise<Id<"strategy_runs"> | undefined> {
    const strategyKey = String(args.strategyId)
    if (args.latestRunIdsByStrategy.has(strategyKey)) {
        return args.latestRunIdsByStrategy.get(strategyKey)
    }

    const runId = await resolveLatestRunIdForStrategy(ctx, args.strategyId)
    args.latestRunIdsByStrategy.set(strategyKey, runId)
    return runId
}

async function resolveExistingProviderCloseOrder(
    ctx: PortfolioMutationCtx,
    args: {
        syntheticOrderId: string
        providerOrderId?: string
    }
): Promise<Doc<"orders"> | null> {
    const bySyntheticOrderId = await ctx.db
        .query("orders")
        .withIndex("by_order_id", (q) => q.eq("orderId", args.syntheticOrderId))
        .first()

    if (bySyntheticOrderId || !args.providerOrderId) {
        return bySyntheticOrderId
    }

    const providerOrderId = args.providerOrderId
    const byProviderOrderId = await ctx.db
        .query("orders")
        .withIndex("by_provider_order_id", (q) => q.eq("providerOrderId", providerOrderId))
        .first()

    return byProviderOrderId && isProviderReconciledCloseOrder(byProviderOrderId)
        ? byProviderOrderId
        : null
}

function isProviderReconciledCloseOrder(order: Doc<"orders">): boolean {
    const intent = readOrderIntentRecord(order.intent)
    const metadata = intent?.metadata
    return order.action === "close" &&
        metadata !== undefined &&
        typeof metadata === "object" &&
        (metadata as Record<string, unknown>).providerReconciledClose === true
}

async function resolveHistoricMT5ProviderCloseCandidates(
    ctx: PortfolioMutationCtx,
    args: {
        app: Doc<"strategies">["app"]
        strategyMap: Map<string, StrategyDoc>
        positionClosures: ProviderPositionClosureInput[]
    }
): Promise<ProviderClosePositionCandidate[]> {
    if (args.app !== "mt5") {
        return []
    }

    const closureIdentityCandidates = new Set<string>()
    for (const closure of args.positionClosures) {
        for (const identifier of buildPositionClosureIdentityCandidates(closure)) {
            closureIdentityCandidates.add(identifier)
        }
    }

    if (closureIdentityCandidates.size === 0) {
        return []
    }

    const candidateStatuses = [
        "filled",
        "partially_filled",
        "cancelled",
        "rejected",
        "expired",
        "timed_out",
    ] as const
    const orders = (
        await Promise.all(candidateStatuses.map(async (status) => await ctx.db
            .query("orders")
            .withIndex("by_app_status", (q) => q.eq("app", args.app).eq("status", status))
            .collect()))
    ).flat()

    return orders
        .filter((order) =>
            isEntryLikeOrder(order) &&
            args.strategyMap.has(String(order.strategyId)) &&
            getOrderProviderIdentifiers(order).some((identifier) => closureIdentityCandidates.has(identifier))
        )
        .map(resolveMT5HistoricProviderCloseCandidate)
        .filter((candidate): candidate is ProviderClosePositionCandidate => candidate !== undefined)
}

function resolveMT5HistoricProviderCloseCandidate(
    order: Doc<"orders">
): ProviderClosePositionCandidate | undefined {
    const providerPositionId = resolveHistoricMT5ProviderPositionId(order)
    const side = resolveOrderPositionSide(order)
    const entryPrice = resolveHistoricOrderEntryPrice(order)
    if (!providerPositionId || !side || entryPrice === undefined) {
        return undefined
    }

    const positionKey = `${order.instrument}:${providerPositionId}`
    return {
        strategyId: order.strategyId,
        runId: order.runId,
        instrument: order.instrument,
        side,
        quantity: order.filledQuantity > 0 ? order.filledQuantity : order.quantity,
        entryPrice,
        providerPositionId,
        positionKey,
        syncedAt: Math.min(order.submittedAt, order.updatedAt),
        requiresStrongClosureIdentity: true,
        sourceOrder: order,
        metadata: JSON.stringify({
            ticket: providerPositionId,
            providerOrderId: order.providerOrderId,
            providerClientOrderId: order.providerClientOrderId,
            providerOrderAliases: order.providerOrderAliases,
            sourceOrderId: order.orderId,
        }),
    }
}

function resolveHistoricMT5ProviderPositionId(order: Doc<"orders">): string | undefined {
    for (const identifier of getOrderProviderIdentifiers(order)) {
        if (/^\d+$/.test(identifier)) {
            return identifier
        }
    }

    return undefined
}

function resolveOrderPositionSide(order: Doc<"orders">): "long" | "short" | undefined {
    const intent = readOrderIntentRecord(order.intent)
    if (intent?.side !== "buy" && intent?.side !== "sell") {
        return undefined
    }

    if (positionMatchesOrderDirection(order, "long")) {
        return "long"
    }
    if (positionMatchesOrderDirection(order, "short")) {
        return "short"
    }

    return undefined
}

function resolveHistoricOrderEntryPrice(order: Doc<"orders">): number | undefined {
    if (order.avgFillPrice !== undefined && Number.isFinite(order.avgFillPrice) && order.avgFillPrice > 0) {
        return order.avgFillPrice
    }

    const intent = readOrderIntentRecord(order.intent)
    const metadata = intent?.metadata && typeof intent.metadata === "object"
        ? intent.metadata as Record<string, unknown>
        : undefined
    return readPositiveNumber(
        intent?.estimatedPrice,
        intent?.limitPrice,
        metadata?.estimatedPrice,
        metadata?.entryPrice
    )
}

function buildPositionClosureKey(closure: ProviderPositionClosureInput): string {
    return [
        closure.instrument,
        closure.side,
        closure.closedAt,
        resolveProviderCloseOrderProviderId(closure) ?? closure.providerPositionId ?? "",
    ].join(":")
}

function readPositiveNumber(...values: unknown[]): number | undefined {
    for (const value of values) {
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
            return value
        }
    }

    return undefined
}

async function resolveExistingCanonicalCloseOrderForClosure(
    ctx: PortfolioMutationCtx,
    args: {
        strategyId: Id<"strategies">
        closure: ProviderPositionClosureInput
    }
): Promise<Doc<"orders"> | undefined> {
    const statuses = ["filled", "partially_filled"] as const
    const orders = (
        await Promise.all(statuses.map(async (status) => await ctx.db
            .query("orders")
            .withIndex("by_strategy_status", (q) => q.eq("strategyId", args.strategyId).eq("status", status))
            .collect()))
    ).flat()
    const closureIds = buildPositionClosureIdentityCandidates(args.closure)

    return orders.find((order) =>
        order.action === "close" &&
        order.instrument === args.closure.instrument &&
        !isSyntheticProviderCloseOrder(order) &&
        hasSharedProviderPositionIdentity(buildOrderCloseIdentityCandidates(order), closureIds)
    )
}

function canonicalCloseNeedsProviderClosureAttach(
    order: Doc<"orders">,
    closure: ProviderPositionClosureInput
): boolean {
    const intent = readOrderIntentRecord(order.intent)
    const metadata = intent?.metadata && typeof intent.metadata === "object"
        ? intent.metadata as Record<string, unknown>
        : undefined
    if (metadata?.providerReconciledClose !== true) {
        return true
    }

    const closureMetadata = parseJson<Record<string, unknown>>(closure.metadata)
    const closurePnl = typeof closureMetadata?.fillPnl === "number"
        ? closureMetadata.fillPnl
        : closureMetadata?.profit
    if (typeof closurePnl === "number" && metadata.fillPnl !== closurePnl) {
        return true
    }

    return false
}

function isSyntheticProviderCloseOrder(order: Doc<"orders">): boolean {
    return order.orderId.startsWith("provider-close:")
}

function isRetiredProviderCloseOrder(order: Doc<"orders">): boolean {
    const intent = readOrderIntentRecord(order.intent)
    const metadata = intent?.metadata && typeof intent.metadata === "object"
        ? intent.metadata as Record<string, unknown>
        : undefined
    return isSyntheticProviderCloseOrder(order) &&
        order.status === "cancelled" &&
        metadata?.providerReconciledCloseRetired === true
}

function buildOrderCloseIdentityCandidates(order: Doc<"orders">): Set<string> {
    const identifiers = new Set<string>()
    const intent = readOrderIntentRecord(order.intent)
    const metadata = intent?.metadata && typeof intent.metadata === "object"
        ? intent.metadata as Record<string, unknown>
        : undefined

    for (const identifier of getOrderProviderIdentifiers(order)) {
        addKnownIdentifier(identifiers, identifier)
        addCompositeProviderOrderIdentifier(identifiers, identifier)
    }

    addKnownIdentifier(identifiers, metadata?.ticket)
    addKnownIdentifier(identifiers, metadata?.identifier)
    addKnownIdentifier(identifiers, metadata?.orderId)
    addKnownIdentifier(identifiers, metadata?.providerOrderId)
    addKnownIdentifier(identifiers, metadata?.providerClientOrderId)
    addKnownIdentifier(identifiers, metadata?.positionId)
    addKnownIdentifier(identifiers, metadata?.providerPositionId)
    addKnownIdentifier(identifiers, metadata?.posId)

    const providerPositionKey = metadata?.providerPositionKey
    addKnownIdentifier(identifiers, providerPositionKey)
    if (typeof providerPositionKey === "string" && providerPositionKey.includes(":")) {
        addKnownIdentifier(identifiers, providerPositionKey.split(":").at(-1))
    }

    return identifiers
}

function addCompositeProviderOrderIdentifier(
    identifiers: Set<string>,
    value: string
): void {
    const parts = value.split(":")
    if (parts.length < 3) {
        return
    }

    addKnownIdentifier(identifiers, parts.at(-1))
}

async function attachProviderClosureToCanonicalCloseOrder(
    ctx: PortfolioMutationCtx,
    args: {
        order: Doc<"orders">
        position: ProviderClosePositionCandidate
        closure: ProviderPositionClosureInput
        updatedAt: number
    }
): Promise<void> {
    await upsertOrderRow(ctx, {
        orderId: args.order.orderId,
        canonicalOrderId: args.order.canonicalOrderId ?? args.order.orderId,
        providerOrderId: args.order.providerOrderId ?? args.order.orderId,
        providerClientOrderId: args.order.providerClientOrderId,
        providerOrderAliases: args.order.providerOrderAliases ?? [],
        submitAttemptId: args.order.submitAttemptId,
        submitAttemptSequence: args.order.submitAttemptSequence,
        commitOutcome: args.order.commitOutcome ?? "accepted",
        signedOrderFingerprint: args.order.signedOrderFingerprint,
        signedOrderMetadata: args.order.signedOrderMetadata,
        runId: args.order.runId,
        strategyId: args.order.strategyId,
        venue: args.order.venue,
        instrument: args.order.instrument,
        status: args.order.status,
        action: args.order.action,
        quantity: args.order.quantity,
        filledQuantity: args.order.filledQuantity,
        remainingQuantity: args.order.remainingQuantity,
        avgFillPrice: args.order.avgFillPrice ?? args.closure.fillPrice,
        submittedAt: args.order.submittedAt,
        updatedAt: args.closure.closedAt,
        intent: buildCanonicalCloseIntentWithProviderClosure(args.order, args.position, args.closure),
        metadata: args.order.metadata,
        lastTransitionSequence: args.order.lastTransitionSequence,
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
        type: "status_change",
        status: args.order.status,
        previousStatus: args.order.status,
        reason: "Provider closure history attached broker-reported realized PnL to this canonical close order",
        details: {
            providerPositionId: args.closure.providerPositionId,
            fillPrice: args.closure.fillPrice,
            quantity: args.closure.quantity,
            metadata: parseJson<Record<string, unknown>>(args.closure.metadata),
        },
        timestamp: args.closure.closedAt,
    })
}

function buildCanonicalCloseIntentWithProviderClosure(
    order: Doc<"orders">,
    position: ProviderClosePositionCandidate,
    closure: ProviderPositionClosureInput
): Record<string, unknown> {
    const intent = readOrderIntentRecord(order.intent) ?? {}
    const currentMetadata = intent.metadata && typeof intent.metadata === "object"
        ? intent.metadata as Record<string, unknown>
        : {}
    const metadata = {
        ...currentMetadata,
        ...readMetadataRecord(position.metadata),
        ...parseJson<Record<string, unknown>>(closure.metadata),
        providerReconciledClose: true,
        providerPositionId: currentMetadata.providerPositionId ?? position.providerPositionId,
        providerPositionKey: currentMetadata.providerPositionKey ?? position.positionKey,
        entryPrice: currentMetadata.entryPrice ?? position.entryPrice,
        positionSide: currentMetadata.positionSide ?? position.side,
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
    await upsertOrderRow(ctx, {
        orderId: args.order.orderId,
        canonicalOrderId: args.canonicalOrderId,
        providerOrderId: args.order.providerOrderId ?? args.order.orderId,
        providerClientOrderId: args.order.providerClientOrderId,
        providerOrderAliases: args.order.providerOrderAliases ?? [],
        submitAttemptId: args.order.submitAttemptId,
        submitAttemptSequence: args.order.submitAttemptSequence,
        commitOutcome: args.order.commitOutcome ?? "accepted",
        signedOrderFingerprint: args.order.signedOrderFingerprint,
        signedOrderMetadata: args.order.signedOrderMetadata,
        runId: args.order.runId,
        strategyId: args.order.strategyId,
        venue: args.order.venue,
        instrument: args.order.instrument,
        status: "cancelled",
        action: args.order.action,
        quantity: args.order.quantity,
        filledQuantity: 0,
        remainingQuantity: args.order.quantity,
        avgFillPrice: args.order.avgFillPrice,
        submittedAt: args.order.submittedAt,
        updatedAt: args.updatedAt,
        intent: buildRetiredProviderCloseIntent(args.order, args.canonicalOrderId),
        metadata: args.order.metadata,
        lastTransitionSequence: args.order.lastTransitionSequence,
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
        previousStatus: args.order.status,
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
    const currentMetadata = intent.metadata && typeof intent.metadata === "object"
        ? intent.metadata as Record<string, unknown>
        : {}

    return {
        ...intent,
        metadata: {
            ...currentMetadata,
            providerReconciledCloseRetired: true,
            providerReconciledDuplicateOfOrderId: canonicalOrderId,
        },
    }
}

async function repairMT5EntryOrderFromProviderClosure(
    ctx: PortfolioMutationCtx,
    args: {
        order: Doc<"orders">
        position: ProviderClosePositionCandidate
        closure: ProviderPositionClosureInput
        updatedAt: number
    }
): Promise<void> {
    const previousStatus = args.order.status
    await upsertOrderRow(ctx, {
        orderId: args.order.orderId,
        canonicalOrderId: args.order.canonicalOrderId ?? args.order.orderId,
        providerOrderId: args.order.providerOrderId ?? args.order.orderId,
        providerClientOrderId: args.order.providerClientOrderId,
        providerOrderAliases: args.order.providerOrderAliases ?? [],
        submitAttemptId: args.order.submitAttemptId,
        submitAttemptSequence: args.order.submitAttemptSequence,
        commitOutcome: args.order.commitOutcome === "accepted" ? "accepted" : "recovered",
        signedOrderFingerprint: args.order.signedOrderFingerprint,
        signedOrderMetadata: args.order.signedOrderMetadata,
        runId: args.order.runId,
        strategyId: args.order.strategyId,
        venue: args.order.venue,
        instrument: args.order.instrument,
        status: "filled",
        action: args.order.action,
        quantity: args.order.quantity,
        filledQuantity: args.position.quantity,
        remainingQuantity: Math.max(args.order.quantity - args.position.quantity, 0),
        avgFillPrice: args.position.entryPrice,
        submittedAt: args.order.submittedAt,
        updatedAt: args.closure.closedAt,
        intent: args.order.intent,
        metadata: args.order.metadata,
        lastTransitionSequence: args.order.lastTransitionSequence,
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

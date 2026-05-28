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

        const syntheticOrderId = buildProviderCloseOrderId(args.app, position, closure)
        const providerOrderId = resolveProviderCloseOrderProviderId(closure)
        const existingOrder = await resolveExistingProviderCloseOrder(ctx, {
            syntheticOrderId,
            providerOrderId,
        })
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

    const orders = [
        ...await ctx.db
            .query("orders")
            .withIndex("by_app_status", (q) => q.eq("app", args.app).eq("status", "filled"))
            .collect(),
        ...await ctx.db
            .query("orders")
            .withIndex("by_app_status", (q) => q.eq("app", args.app).eq("status", "partially_filled"))
            .collect(),
    ]

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
    const estimatedPrice = intent?.estimatedPrice
    return typeof estimatedPrice === "number" && Number.isFinite(estimatedPrice) && estimatedPrice > 0
        ? estimatedPrice
        : undefined
}

function buildPositionClosureKey(closure: ProviderPositionClosureInput): string {
    return [
        closure.instrument,
        closure.side,
        closure.closedAt,
        resolveProviderCloseOrderProviderId(closure) ?? closure.providerPositionId ?? "",
    ].join(":")
}

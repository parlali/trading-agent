import type { Doc, Id } from "../../_generated/dataModel"
import type {
    PortfolioMutationCtx,
    ProviderPositionClosureInput,
    StrategyDoc,
} from "./portfolioTypes"
import {
    almostEqual,
    isEntryLikeOrder,
    parseJson,
    readOrderIntentRecord,
} from "./portfolioUtils"
import { resolveLatestRunIdForStrategy } from "./portfolioOrderRuns"
import {
    getOrderProviderIdentifiers,
    positionMatchesOrderDirection,
} from "./portfolioOrderInference"
import {
    addKnownIdentifier,
    buildPositionClosureIdentityCandidates,
    buildPositionClosureKey,
    buildProviderPositionIdentityCandidates,
    describeClosure,
    hasSharedProviderPositionIdentity,
    isRetiredProviderCloseOrder,
    isSyntheticProviderCloseOrder,
    readIdentifier,
    readOrderIntentMetadata,
    type ProviderClosePositionCandidate,
} from "./portfolioCloseIdentity"
import {
    attachClosureToCanonicalCloseOrder,
    importSyntheticProviderClose,
    repairMT5EntryOrderFromProviderClosure,
} from "./portfolioOrderClosureWrites"

const PROVIDER_CLOSURE_TIME_SKEW_MS = 5 * 60 * 1000

const CLOSURE_TRUTH_APPS = new Set<Doc<"strategies">["app"]>(["mt5", "okx-swap"])

interface TrackedClosureCandidate {
    position: ProviderClosePositionCandidate
    remainingQuantity: number
    attributedQuantity: number
    historic: boolean
}

export interface ProviderClosureReconciliationResult {
    unattributedClosures: string[]
    unmatchedClosedPositions: string[]
}

type CandidateMatch =
    | { kind: "matched"; candidate: TrackedClosureCandidate }
    | { kind: "none" }
    | { kind: "ambiguous"; reason: string }

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
): Promise<ProviderClosureReconciliationResult> {
    const disappearedCandidates: TrackedClosureCandidate[] = args.existingProviderPositions
        .filter((position) =>
            position.ownershipStatus === "owned" &&
            position.strategyId !== undefined &&
            position.expectedExternal !== true &&
            args.strategyMap.has(String(position.strategyId)) &&
            !args.livePositionKeys.has(position.positionKey)
        )
        .map((position) => trackCandidate({ ...position, strategyId: position.strategyId! }, false))

    if (args.positionClosures.length === 0 && disappearedCandidates.length === 0) {
        return { unattributedClosures: [], unmatchedClosedPositions: [] }
    }

    const historicCandidates = (await resolveHistoricMT5ProviderCloseCandidates(ctx, args))
        .map((position) => trackCandidate(position, true))
    const candidates = [...disappearedCandidates, ...historicCandidates]
    const latestRunIdsByStrategy = new Map<string, Id<"strategy_runs"> | undefined>()
    const importedClosureKeys = new Set<string>()
    const unattributedClosures: string[] = []
    const sortedClosures = [...args.positionClosures].sort((left, right) => left.closedAt - right.closedAt)

    for (const closure of sortedClosures) {
        const closureKey = buildPositionClosureKey(closure)
        if (importedClosureKeys.has(closureKey)) {
            continue
        }

        const orderMatch = await resolveCloseOrderByProviderIdentity(ctx, {
            closure,
            strategyMap: args.strategyMap,
        })

        if (orderMatch?.kind === "synthetic") {
            const candidate = consumeCandidateForOrder(candidates, closure, orderMatch.order)
            if (!isRetiredProviderCloseOrder(orderMatch.order)) {
                const canonicalCloseOrder = await resolveExistingCanonicalCloseOrderForClosure(ctx, {
                    strategyId: orderMatch.order.strategyId,
                    closure,
                })
                if (canonicalCloseOrder) {
                    await attachClosureToCanonicalCloseOrder(ctx, {
                        order: canonicalCloseOrder,
                        position: candidate?.position,
                        closure,
                        updatedAt: args.updatedAt,
                    })
                }
            }
            consumeCandidate(candidate, closure.quantity)
            importedClosureKeys.add(closureKey)
            continue
        }

        if (orderMatch?.kind === "canonical") {
            const candidate = consumeCandidateForOrder(candidates, closure, orderMatch.order)
            await attachClosureToCanonicalCloseOrder(ctx, {
                order: orderMatch.order,
                position: candidate?.position,
                closure,
                updatedAt: args.updatedAt,
            })
            consumeCandidate(candidate, closure.quantity)
            importedClosureKeys.add(closureKey)
            continue
        }

        const match = resolveMatchingCandidatePosition(candidates, closure)
        if (match.kind === "none") {
            continue
        }

        if (match.kind === "ambiguous") {
            unattributedClosures.push(`${describeClosure(closure)} (${match.reason})`)
            continue
        }

        const candidate = match.candidate
        const position = candidate.position
        const runId = position.runId ?? await resolveProviderCloseRunId(ctx, {
            strategyId: position.strategyId,
            latestRunIdsByStrategy,
        })
        if (!runId) {
            unattributedClosures.push(`${describeClosure(closure)} (owning strategy has no run to attribute the close to)`)
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

        const canonicalCloseOrder = await resolveExistingCanonicalCloseOrderForClosure(ctx, {
            strategyId: position.strategyId,
            closure,
        })

        if (canonicalCloseOrder) {
            await attachClosureToCanonicalCloseOrder(ctx, {
                order: canonicalCloseOrder,
                position,
                closure,
                updatedAt: args.updatedAt,
            })
        } else {
            await importSyntheticProviderClose(ctx, {
                app: args.app,
                position,
                closure,
                runId,
                updatedAt: args.updatedAt,
            })
        }

        consumeCandidate(candidate, closure.quantity)
        importedClosureKeys.add(closureKey)
    }

    return {
        unattributedClosures,
        unmatchedClosedPositions: CLOSURE_TRUTH_APPS.has(args.app)
            ? await resolveUnmatchedClosedPositions(ctx, candidates)
            : [],
    }
}

function trackCandidate(
    position: ProviderClosePositionCandidate,
    historic: boolean
): TrackedClosureCandidate {
    return {
        position,
        remainingQuantity: position.quantity,
        attributedQuantity: 0,
        historic,
    }
}

function consumeCandidate(
    candidate: TrackedClosureCandidate | undefined,
    quantity: number
): void {
    if (!candidate) {
        return
    }

    candidate.remainingQuantity = Math.max(candidate.remainingQuantity - quantity, 0)
    candidate.attributedQuantity += quantity
}

function isCandidateConsumed(candidate: TrackedClosureCandidate): boolean {
    return candidate.attributedQuantity > 0 && almostEqual(candidate.remainingQuantity, 0)
}

function consumeCandidateForOrder(
    candidates: TrackedClosureCandidate[],
    closure: ProviderPositionClosureInput,
    order: Doc<"orders">
): TrackedClosureCandidate | undefined {
    return candidates.find((candidate) =>
        !isCandidateConsumed(candidate) &&
        candidate.position.instrument === closure.instrument &&
        candidate.position.side === closure.side &&
        candidate.position.strategyId === order.strategyId
    )
}

function resolveMatchingCandidatePosition(
    candidates: TrackedClosureCandidate[],
    closure: ProviderPositionClosureInput
): CandidateMatch {
    const closureIds = buildPositionClosureIdentityCandidates(closure)
    const eligible = candidates.filter((candidate) =>
        !isCandidateConsumed(candidate) &&
        candidate.position.instrument === closure.instrument &&
        candidate.position.side === closure.side &&
        closure.closedAt >= candidate.position.syncedAt - PROVIDER_CLOSURE_TIME_SKEW_MS
    )

    if (eligible.length === 0) {
        return { kind: "none" }
    }

    const strongMatches = eligible.filter((candidate) =>
        hasSharedProviderPositionIdentity(
            buildProviderPositionIdentityCandidates(candidate.position),
            closureIds
        )
    )
    if (strongMatches.length === 1) {
        return { kind: "matched", candidate: strongMatches[0]! }
    }
    if (strongMatches.length > 1) {
        return { kind: "ambiguous", reason: "multiple owned positions share the provider close identity" }
    }

    const weakMatches = eligible.filter((candidate) =>
        candidate.position.requiresStrongClosureIdentity !== true
    )
    if (weakMatches.length === 0) {
        return { kind: "none" }
    }

    const quantityMatches = weakMatches.filter((candidate) =>
        almostEqual(closure.quantity, candidate.remainingQuantity)
    )
    if (quantityMatches.length === 1) {
        return { kind: "matched", candidate: quantityMatches[0]! }
    }
    if (weakMatches.length === 1) {
        return { kind: "matched", candidate: weakMatches[0]! }
    }

    return { kind: "ambiguous", reason: "multiple owned positions are eligible without provider identity evidence" }
}

async function resolveUnmatchedClosedPositions(
    ctx: PortfolioMutationCtx,
    candidates: TrackedClosureCandidate[]
): Promise<string[]> {
    const unmatched: string[] = []

    for (const candidate of candidates) {
        if (candidate.historic || candidate.attributedQuantity > 0) {
            continue
        }

        if (await hasRecentFilledCanonicalClose(ctx, candidate.position)) {
            continue
        }

        unmatched.push(candidate.position.positionKey)
    }

    return unmatched
}

async function hasRecentFilledCanonicalClose(
    ctx: PortfolioMutationCtx,
    position: ProviderClosePositionCandidate
): Promise<boolean> {
    const statuses = ["filled", "partially_filled"] as const
    for (const status of statuses) {
        const orders = await ctx.db
            .query("orders")
            .withIndex("by_strategy_status", (q) =>
                q.eq("strategyId", position.strategyId).eq("status", status)
            )
            .collect()
        const match = orders.some((order) =>
            order.action === "close" &&
            order.instrument === position.instrument &&
            order.updatedAt >= position.syncedAt - PROVIDER_CLOSURE_TIME_SKEW_MS
        )
        if (match) {
            return true
        }
    }

    return false
}

async function resolveCloseOrderByProviderIdentity(
    ctx: PortfolioMutationCtx,
    args: {
        closure: ProviderPositionClosureInput
        strategyMap: Map<string, StrategyDoc>
    }
): Promise<{ kind: "canonical" | "synthetic"; order: Doc<"orders"> } | undefined> {
    const metadata = parseJson<Record<string, unknown>>(args.closure.metadata)
    const identifiers = new Set<string>()
    addKnownIdentifier(identifiers, metadata?.clientOrderId)
    const orderId = readIdentifier(metadata?.orderId)
    if (orderId) {
        identifiers.add(orderId)
        identifiers.add(`order:${args.closure.instrument}:${orderId}`)
    }

    let syntheticMatch: Doc<"orders"> | undefined
    for (const identifier of identifiers) {
        const order = await findCloseOrderByIdentifier(ctx, identifier)
        if (!order || order.instrument !== args.closure.instrument || !args.strategyMap.has(String(order.strategyId))) {
            continue
        }

        if (isSyntheticProviderCloseOrder(order)) {
            syntheticMatch = order
            continue
        }

        if (order.action === "close") {
            return { kind: "canonical", order }
        }
    }

    return syntheticMatch ? { kind: "synthetic", order: syntheticMatch } : undefined
}

async function findCloseOrderByIdentifier(
    ctx: PortfolioMutationCtx,
    identifier: string
): Promise<Doc<"orders"> | null> {
    const byOrderId = await ctx.db
        .query("orders")
        .withIndex("by_order_id", (q) => q.eq("orderId", identifier))
        .first()
    if (byOrderId) {
        return byOrderId
    }

    const byProviderClientOrderId = await ctx.db
        .query("orders")
        .withIndex("by_provider_client_order_id", (q) => q.eq("providerClientOrderId", identifier))
        .first()
    if (byProviderClientOrderId) {
        return byProviderClientOrderId
    }

    return await ctx.db
        .query("orders")
        .withIndex("by_provider_order_id", (q) => q.eq("providerOrderId", identifier))
        .first()
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

async function resolveHistoricMT5ProviderCloseCandidates(
    ctx: PortfolioMutationCtx,
    args: {
        app: Doc<"strategies">["app"]
        strategyMap: Map<string, StrategyDoc>
        positionClosures: ProviderPositionClosureInput[]
    }
): Promise<ProviderClosePositionCandidate[]> {
    if (args.app !== "mt5" || args.positionClosures.length === 0) {
        return []
    }

    const closureIdentityCandidates = new Set<string>()
    for (const closure of args.positionClosures) {
        for (const identifier of buildPositionClosureIdentityCandidates(closure)) {
            closureIdentityCandidates.add(identifier)
        }
    }

    const candidates: ProviderClosePositionCandidate[] = []
    const seenOrderIds = new Set<string>()

    for (const identifier of closureIdentityCandidates) {
        const order = await findCloseOrderByIdentifier(ctx, identifier)
        if (
            !order ||
            order.app !== args.app ||
            seenOrderIds.has(order.orderId) ||
            !isEntryLikeOrder(order) ||
            !isTerminalHistoricOrderStatus(order.status) ||
            !args.strategyMap.has(String(order.strategyId))
        ) {
            continue
        }

        seenOrderIds.add(order.orderId)
        const candidate = resolveMT5HistoricProviderCloseCandidate(order)
        if (candidate) {
            candidates.push(candidate)
        }
    }

    return candidates
}

function isTerminalHistoricOrderStatus(status: Doc<"orders">["status"]): boolean {
    return status !== "pending"
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
    const metadata = readOrderIntentMetadata(order)
    return readPositiveNumber(
        intent?.estimatedPrice,
        intent?.limitPrice,
        metadata?.estimatedPrice,
        metadata?.entryPrice
    )
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

function buildOrderCloseIdentityCandidates(order: Doc<"orders">): Set<string> {
    const identifiers = new Set<string>()
    const metadata = readOrderIntentMetadata(order)

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

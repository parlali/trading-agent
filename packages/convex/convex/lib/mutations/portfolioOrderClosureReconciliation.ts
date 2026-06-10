import type { Doc, Id } from "../../_generated/dataModel"
import type {
    PortfolioMutationCtx,
    ProviderPositionClosureInput,
    StrategyDoc,
} from "./portfolioTypes"
import { appendOrderTransition, patchOrderRowFromDoc, upsertOrderRow } from "./orders"
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

const PROVIDER_CLOSURE_TIME_SKEW_MS = 5 * 60 * 1000

const CLOSURE_TRUTH_APPS = new Set<Doc<"strategies">["app"]>(["mt5", "okx-swap"])

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

async function attachClosureToCanonicalCloseOrder(
    ctx: PortfolioMutationCtx,
    args: {
        order: Doc<"orders">
        position?: ProviderClosePositionCandidate
        closure: ProviderPositionClosureInput
        updatedAt: number
    }
): Promise<void> {
    if (canonicalCloseNeedsProviderClosureAttach(args.order, args.closure)) {
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

async function importSyntheticProviderClose(
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
    addKnownIdentifier(identifiers, metadata?.posId)
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
    addKnownIdentifier(identifiers, metadata?.clientOrderId)
    addKnownIdentifier(identifiers, metadata?.posId)
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
    const identifier = readIdentifier(value)
    if (identifier) {
        identifiers.add(identifier)
    }
}

function readIdentifier(value: unknown): string | undefined {
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

function describeClosure(closure: ProviderPositionClosureInput): string {
    return [
        closure.instrument,
        closure.side,
        closure.quantity,
        new Date(closure.closedAt).toISOString(),
    ].join(":")
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

function readOrderIntentMetadata(order: Doc<"orders">): Record<string, unknown> | undefined {
    const intent = readOrderIntentRecord(order.intent)
    const metadata = intent?.metadata
    return metadata !== undefined && typeof metadata === "object" && metadata !== null
        ? metadata as Record<string, unknown>
        : undefined
}

function isProviderReconciledCloseOrder(order: Doc<"orders">): boolean {
    return order.action === "close" &&
        readOrderIntentMetadata(order)?.providerReconciledClose === true
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

function isSyntheticProviderCloseOrder(order: Doc<"orders">): boolean {
    return order.orderId.startsWith("provider-close:")
}

function isRetiredProviderCloseOrder(order: Doc<"orders">): boolean {
    return isSyntheticProviderCloseOrder(order) &&
        order.status === "cancelled" &&
        readOrderIntentMetadata(order)?.providerReconciledCloseRetired === true
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

async function attachProviderClosureToCanonicalCloseOrder(
    ctx: PortfolioMutationCtx,
    args: {
        order: Doc<"orders">
        position?: ProviderClosePositionCandidate
        closure: ProviderPositionClosureInput
        updatedAt: number
    }
): Promise<void> {
    await patchOrderRowFromDoc(ctx, args.order, {
        avgFillPrice: args.order.avgFillPrice ?? args.closure.fillPrice,
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

    return {
        ...intent,
        metadata: {
            ...(readOrderIntentMetadata(order) ?? {}),
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

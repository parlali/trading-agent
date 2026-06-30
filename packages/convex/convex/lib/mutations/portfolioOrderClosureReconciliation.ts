import type { Doc, Id } from "../../_generated/dataModel"
import type {
    PortfolioMutationCtx,
    ProviderPositionClosureInput,
    StrategyDoc,
} from "./portfolioTypes"
import {
    almostEqual,
    hasProviderAccountingMetadata,
    hasNonZeroProviderAccountingMetadata,
    isEntryLikeOrder,
    parseJson,
    readOrderIntentRecord,
    isExpectedExternalProviderRow,
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
    orderBelongsToAccount,
    readIdentifier,
    readOrderIntentMetadata,
    type ProviderClosePositionCandidate,
} from "./portfolioCloseIdentity"
import {
    attachClosureToCanonicalCloseOrder,
    importSyntheticProviderClose,
    repairMT5EntryOrderFromProviderClosure,
} from "./portfolioOrderClosureWrites"
import { findOrderRowByAlias } from "../orderIdentityAliases"
import { getProviderInstrumentClaimAliases } from "../instrumentClaims"

const PROVIDER_CLOSURE_TIME_SKEW_MS = 5 * 60 * 1000
const HISTORIC_CANONICAL_CLOSE_MATCH_WINDOW_MS = 24 * 60 * 60 * 1000
const HISTORIC_MT5_ENTRY_ORDER_STATUSES = ["filled", "partially_filled", "cancelled", "rejected", "expired", "timed_out"] as const

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
        accountId: string
        strategyMap: Map<string, StrategyDoc>
        existingProviderPositions: Doc<"provider_positions">[]
        livePositionKeys: Set<string>
        positionClosures: ProviderPositionClosureInput[]
        expectedExternalInstruments: Set<string>
        updatedAt: number
    }
): Promise<ProviderClosureReconciliationResult> {
    const disappearedCandidates: TrackedClosureCandidate[] = args.existingProviderPositions
        .filter((position) =>
            position.ownershipStatus === "owned" &&
            position.strategyId !== undefined &&
            position.expectedExternal !== true &&
            args.strategyMap.has(String(position.strategyId)) &&
            !isProviderPositionLive(position, args.livePositionKeys)
        )
        .map((position) => trackCandidate({ ...position, strategyId: position.strategyId! }, false))

    const mt5HistoricCandidates = (await resolveHistoricMT5ProviderCloseCandidates(ctx, args))
        .map((position) => trackCandidate(position, true))
    const okxHistoricCandidates = (await resolveHistoricOKXProviderCloseCandidates(ctx, args))
        .map((position) => trackCandidate(position, true))
    const faultBackedCandidates = (await resolveFaultBackedProviderCloseCandidates(ctx, args))
        .map((position) => trackCandidate(position, true))
    const candidates = canonicalizeTrackedClosureCandidates([
        ...disappearedCandidates,
        ...faultBackedCandidates,
        ...mt5HistoricCandidates,
        ...okxHistoricCandidates,
    ])

    if (args.positionClosures.length === 0 && candidates.length === 0) {
        return { unattributedClosures: [], unmatchedClosedPositions: [] }
    }
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
            app: args.app,
            accountId: args.accountId,
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
                await attachClosureToCanonicalCloseOrder(ctx, {
                    order: canonicalCloseOrder ?? orderMatch.order,
                    position: candidate?.position,
                    closure,
                    updatedAt: args.updatedAt,
                })
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

        const match = resolveMatchingCandidatePosition(candidates, closure, args.app)
        if (match.kind === "none") {
            if (isExpectedExternalProviderRow(args.expectedExternalInstruments, closure)) {
                importedClosureKeys.add(closureKey)
                continue
            }

            if (hasProviderAccountingEvidence(closure)) {
                const description = `${describeClosure(closure)} (broker close has provider accounting but no canonical order or owned position candidate)`
                unattributedClosures.push(description)
                await recordUnattributedClosureFaults(ctx, {
                    app: args.app,
                    accountId: args.accountId,
                    strategyMap: args.strategyMap,
                    closure,
                    description,
                    updatedAt: args.updatedAt,
                })
            }
            continue
        }

        if (match.kind === "ambiguous") {
            if (hasProviderAccountingEvidence(closure)) {
                const description = `${describeClosure(closure)} (broker close has provider accounting but attribution is ambiguous: ${match.reason})`
                unattributedClosures.push(description)
                await recordUnattributedClosureFaults(ctx, {
                    app: args.app,
                    accountId: args.accountId,
                    strategyMap: args.strategyMap,
                    closure,
                    description,
                    updatedAt: args.updatedAt,
                })
            } else {
                unattributedClosures.push(`${describeClosure(closure)} (${match.reason})`)
            }
            continue
        }

        const candidate = match.candidate
        const position = candidate.position
        const runId = position.runId ?? await resolveProviderCloseRunId(ctx, {
            strategyId: position.strategyId,
            latestRunIdsByStrategy,
        })
        if (!runId) {
            if (hasProviderAccountingEvidence(closure)) {
                const description = `${describeClosure(closure)} (broker close has provider accounting but the owning strategy has no run to attribute the close to)`
                unattributedClosures.push(description)
                await recordUnattributedClosureFaults(ctx, {
                    app: args.app,
                    accountId: args.accountId,
                    strategyMap: args.strategyMap,
                    closure,
                    description,
                    updatedAt: args.updatedAt,
                })
            } else {
                unattributedClosures.push(`${describeClosure(closure)} (owning strategy has no run to attribute the close to)`)
            }
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

    const unmatchedClosedPositions = await resolveUnmatchedClosedPositions(ctx, {
        app: args.app,
        candidates,
    })

    if (!CLOSURE_TRUTH_APPS.has(args.app)) {
        await recordVanishedPositionFaults(ctx, {
            app: args.app,
            accountId: args.accountId,
            candidates,
            unmatchedPositionKeys: unmatchedClosedPositions,
            updatedAt: args.updatedAt,
        })
    }

    return {
        unattributedClosures,
        unmatchedClosedPositions,
    }
}

async function recordVanishedPositionFaults(
    ctx: PortfolioMutationCtx,
    args: {
        app: Doc<"strategies">["app"]
        accountId: string
        candidates: TrackedClosureCandidate[]
        unmatchedPositionKeys: string[]
        updatedAt: number
    }
): Promise<void> {
    if (args.unmatchedPositionKeys.length === 0) {
        return
    }

    const unmatchedKeys = new Set(args.unmatchedPositionKeys)
    const existingFaults = await ctx.db
        .query("execution_safety_faults")
        .withIndex("by_app_account_blocked", (q) =>
            q.eq("app", args.app).eq("accountId", args.accountId).eq("blocked", true)
        )
        .collect()

    for (const candidate of args.candidates) {
        if (candidate.historic || !unmatchedKeys.has(candidate.position.positionKey)) {
            continue
        }

        const message = `Owned position ${candidate.position.positionKey} disappeared from ${args.app} without close evidence or a canonical close order; realized PnL for this exit is unaccounted (expiry, assignment, or settlement must be reconciled manually)`
        const duplicate = existingFaults.some((fault) =>
            fault.strategyId === candidate.position.strategyId &&
            fault.instrument === candidate.position.instrument &&
            fault.category === "accounting_mismatch" &&
            fault.message === message
        )
        if (duplicate) {
            continue
        }

        await ctx.db.insert("execution_safety_faults", {
            strategyId: candidate.position.strategyId,
            app: args.app,
            accountId: args.accountId,
            instrument: candidate.position.instrument,
            category: "accounting_mismatch",
            message,
            providerPayload: JSON.stringify({
                positionKey: candidate.position.positionKey,
                instrument: candidate.position.instrument,
                side: candidate.position.side,
                quantity: candidate.position.quantity,
                entryPrice: candidate.position.entryPrice,
            }),
            blocked: true,
            occurredAt: args.updatedAt,
            resolvedAt: undefined,
        })
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

function isProviderPositionLive(
    position: Pick<ProviderClosePositionCandidate, "instrument" | "side" | "providerPositionId" | "positionKey" | "metadata">,
    livePositionKeys: Set<string>
): boolean {
    if (livePositionKeys.has(position.positionKey)) {
        return true
    }

    for (const identifier of buildProviderPositionIdentityCandidates(position)) {
        if (livePositionKeys.has(identifier)) {
            return true
        }
    }

    return false
}

function canonicalizeTrackedClosureCandidates(
    candidates: TrackedClosureCandidate[]
): TrackedClosureCandidate[] {
    const canonical: TrackedClosureCandidate[] = []

    for (const candidate of candidates) {
        const existingIndex = canonical.findIndex((existing) =>
            buildTrackedCandidateLifecycleKey(existing) === buildTrackedCandidateLifecycleKey(candidate)
        )
        if (existingIndex < 0) {
            canonical.push(candidate)
            continue
        }

        const existing = canonical[existingIndex]!
        if (!canCoalesceTrackedCandidate(existing, candidate)) {
            canonical.push(candidate)
            continue
        }

        canonical[existingIndex] = preferTrackedClosureCandidate(existing, candidate)
    }

    return canonical
}

function buildTrackedCandidateLifecycleKey(candidate: TrackedClosureCandidate): string {
    const position = candidate.position
    const providerPositionIdentity = readIdentifier(position.providerPositionId) ?? readIdentifier(position.positionKey)

    return [
        position.accountId,
        position.instrument,
        providerPositionIdentity ?? position.positionKey,
    ].join("\u0000")
}

function canCoalesceTrackedCandidate(
    left: TrackedClosureCandidate,
    right: TrackedClosureCandidate
): boolean {
    return left.position.accountId === right.position.accountId &&
        left.position.instrument === right.position.instrument &&
        left.position.side === right.position.side &&
        left.position.strategyId === right.position.strategyId
}

function preferTrackedClosureCandidate(
    left: TrackedClosureCandidate,
    right: TrackedClosureCandidate
): TrackedClosureCandidate {
    if (!right.historic && left.historic) {
        return right
    }

    if (right.position.sourceOrder && !left.position.sourceOrder) {
        return right
    }

    if (right.position.syncedAt > left.position.syncedAt) {
        return right
    }

    return left
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
    const closureIds = buildPositionClosureIdentityCandidates(closure)

    return candidates.find((candidate) =>
        !isCandidateConsumed(candidate) &&
        candidate.position.instrument === closure.instrument &&
        candidate.position.side === closure.side &&
        candidate.position.strategyId === order.strategyId &&
        hasSharedProviderPositionIdentity(
            buildProviderPositionIdentityCandidates(candidate.position),
            closureIds
        )
    )
}

function resolveMatchingCandidatePosition(
    candidates: TrackedClosureCandidate[],
    closure: ProviderPositionClosureInput,
    app: Doc<"strategies">["app"]
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

    if (
        app === "okx-swap" &&
        !hasExplicitProviderPositionIdentity(closure) &&
        hasAuditedOKXCloseEvidence(closure)
    ) {
        if (eligible.length === 1) {
            return { kind: "matched", candidate: eligible[0]! }
        }

        if (eligible.length > 1) {
            return {
                kind: "ambiguous",
                reason: "multiple recently owned OKX positions match the close instrument, side, and time window without provider position identity",
            }
        }
    }

    return { kind: "none" }
}

function hasExplicitProviderPositionIdentity(closure: ProviderPositionClosureInput): boolean {
    const metadata = parseJson<Record<string, unknown>>(closure.metadata)
    return readIdentifier(closure.providerPositionId) !== undefined ||
        readIdentifier(metadata?.posId) !== undefined ||
        readIdentifier(metadata?.positionId) !== undefined ||
        readIdentifier(metadata?.providerPositionId) !== undefined ||
        readIdentifier(metadata?.providerPositionKey) !== undefined
}

function hasAuditedOKXCloseEvidence(closure: ProviderPositionClosureInput): boolean {
    const metadata = parseJson<Record<string, unknown>>(closure.metadata)
    if (metadata?.source !== "okx_fills_history") {
        return false
    }

    if (
        readIdentifier(metadata?.orderId) ||
        readIdentifier(metadata?.clientOrderId) ||
        readIdentifier(metadata?.triggeredOrderId) ||
        readIdentifier(metadata?.algoId) ||
        readIdentifier(metadata?.algoClOrdId) ||
        readIdentifier(metadata?.actualOrdId)
    ) {
        return true
    }

    if (Array.isArray(metadata?.tradeIds) && metadata.tradeIds.some((value) => readIdentifier(value))) {
        return true
    }

    if (Array.isArray(metadata?.providerOrderAliases) && metadata.providerOrderAliases.some((value) => readIdentifier(value))) {
        return true
    }

    return false
}

function hasProviderAccountingEvidence(closure: ProviderPositionClosureInput): boolean {
    const metadata = parseJson<Record<string, unknown>>(closure.metadata)
    return hasProviderAccountingMetadata(metadata)
}

async function recordUnattributedClosureFaults(
    ctx: PortfolioMutationCtx,
    args: {
        app: Doc<"strategies">["app"]
        accountId: string
        strategyMap: Map<string, StrategyDoc>
        closure: ProviderPositionClosureInput
        description: string
        updatedAt: number
    }
): Promise<void> {
    const strategies = await resolveStrategiesForUnattributedClosureFault(ctx, args)
    if (strategies.length === 0) {
        return
    }

    const existingFaults = await ctx.db
        .query("execution_safety_faults")
        .withIndex("by_app_account_blocked", (q) =>
            q.eq("app", args.app).eq("accountId", args.accountId).eq("blocked", true)
        )
        .collect()
    const providerPayload = JSON.stringify({
        closure: args.closure,
        metadata: parseJson<Record<string, unknown>>(args.closure.metadata),
    })

    for (const strategy of strategies) {
        const message = `Provider reconciliation found an unattributed money-bearing close: ${args.description}`
        const duplicate = existingFaults.some((fault) =>
            fault.strategyId === strategy._id &&
            fault.instrument === args.closure.instrument &&
            fault.category === "unattributed_closure" &&
            fault.message === message
        )
        if (duplicate) {
            continue
        }

        await ctx.db.insert("execution_safety_faults", {
            strategyId: strategy._id,
            app: args.app,
            accountId: args.accountId,
            instrument: args.closure.instrument,
            category: "unattributed_closure",
            message,
            providerPayload,
            blocked: true,
            occurredAt: args.updatedAt,
            resolvedAt: undefined,
            resolutionNote: undefined,
        })
    }
}

async function resolveStrategiesForUnattributedClosureFault(
    ctx: PortfolioMutationCtx,
    args: {
        app: Doc<"strategies">["app"]
        accountId: string
        strategyMap: Map<string, StrategyDoc>
        closure: ProviderPositionClosureInput
    }
): Promise<StrategyDoc[]> {
    const strategies = Array.from(args.strategyMap.values())
    if (strategies.length <= 1) {
        return strategies
    }

    const closureAliases = new Set(getProviderInstrumentClaimAliases(args.app, args.closure.instrument, args.closure.metadata))
    const claims = await ctx.db
        .query("instrument_claims")
        .withIndex("by_app_account", (q) => q.eq("app", args.app).eq("accountId", args.accountId))
        .collect()
    const strategyIds = new Set<string>()

    for (const claim of claims) {
        if (!closureAliases.has(claim.instrument) || !args.strategyMap.has(String(claim.strategyId))) {
            continue
        }

        strategyIds.add(String(claim.strategyId))
    }

    if (strategyIds.size === 0) {
        return []
    }

    return strategies.filter((strategy) => strategyIds.has(String(strategy._id)))
}

async function resolveUnmatchedClosedPositions(
    ctx: PortfolioMutationCtx,
    args: {
        app: Doc<"strategies">["app"]
        candidates: TrackedClosureCandidate[]
    }
): Promise<string[]> {
    const unmatched: string[] = []

    for (const candidate of args.candidates) {
        if (candidate.attributedQuantity > 0) {
            continue
        }

        if (await hasRecentFilledCanonicalClose(ctx, args.app, candidate.position)) {
            continue
        }

        unmatched.push(candidate.position.positionKey)
    }

    return unmatched
}

async function hasRecentFilledCanonicalClose(
    ctx: PortfolioMutationCtx,
    app: Doc<"strategies">["app"],
    position: ProviderClosePositionCandidate
): Promise<boolean> {
    const orders = await collectRecentStrategyOrdersByStatuses(ctx, {
        strategyId: position.strategyId,
        statuses: ["filled", "partially_filled"],
        updatedAtFrom: position.syncedAt - PROVIDER_CLOSURE_TIME_SKEW_MS,
        updatedAtTo: position.syncedAt + HISTORIC_CANONICAL_CLOSE_MATCH_WINDOW_MS,
    })

    return orders.some((order) =>
        order.action === "close" &&
        order.instrument === position.instrument &&
        orderBelongsToAccount(order, app, position.accountId) &&
        (
            hasSharedProviderPositionIdentity(
                buildOrderCloseIdentityCandidates(order),
                buildProviderPositionIdentityCandidates(position)
            ) ||
            isAuditedOKXCloseOrderMatch(app, order, position)
        )
    )
}

function isAuditedOKXCloseOrderMatch(
    app: Doc<"strategies">["app"],
    order: Doc<"orders">,
    position: ProviderClosePositionCandidate
): boolean {
    if (app !== "okx-swap") {
        return false
    }

    const metadata = readOrderIntentMetadata(order)
    if (
        metadata?.providerReconciledClose !== true ||
        metadata.source !== "okx_fills_history" ||
        metadata.positionSide !== position.side ||
        !hasNonZeroProviderAccountingMetadata(metadata)
    ) {
        return false
    }

    const filledQuantity = order.filledQuantity > 0 ? order.filledQuantity : order.quantity
    return almostEqual(filledQuantity, position.quantity)
}

async function resolveCloseOrderByProviderIdentity(
    ctx: PortfolioMutationCtx,
    args: {
        app: Doc<"strategies">["app"]
        accountId: string
        closure: ProviderPositionClosureInput
        strategyMap: Map<string, StrategyDoc>
    }
): Promise<{ kind: "canonical" | "synthetic"; order: Doc<"orders"> } | undefined> {
    const metadata = parseJson<Record<string, unknown>>(args.closure.metadata)
    const identifiers = new Set<string>()
    addKnownIdentifier(identifiers, metadata?.providerOrderId)
    addKnownIdentifier(identifiers, metadata?.providerActivityId)
    addKnownIdentifier(identifiers, metadata?.activityId)
    addKnownIdentifier(identifiers, metadata?.clientOrderId)
    addKnownIdentifier(identifiers, metadata?.triggeredOrderId)
    addKnownIdentifier(identifiers, metadata?.algoId)
    addKnownIdentifier(identifiers, metadata?.algoClOrdId)
    addKnownIdentifier(identifiers, metadata?.actualOrdId)
    if (Array.isArray(metadata?.providerOrderAliases)) {
        for (const alias of metadata.providerOrderAliases) {
            addKnownIdentifier(identifiers, alias)
        }
    }
    const orderId = readIdentifier(metadata?.orderId)
    if (orderId) {
        identifiers.add(orderId)
        identifiers.add(`order:${args.closure.instrument}:${orderId}`)
    }

    let syntheticMatch: Doc<"orders"> | undefined
    for (const identifier of identifiers) {
        const order = await findCloseOrderByIdentifier(ctx, {
            app: args.app,
            accountId: args.accountId,
            identifier,
        })
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
    args: {
        app: Doc<"strategies">["app"]
        accountId: string
        identifier: string
    }
): Promise<Doc<"orders"> | null> {
    const byOrderId = await ctx.db
        .query("orders")
        .withIndex("by_order_id", (q) => q.eq("orderId", args.identifier))
        .collect()
    const ownedByOrderId = byOrderId.find((order) => orderBelongsToAccount(order, args.app, args.accountId))
    if (ownedByOrderId) {
        return ownedByOrderId
    }

    const byProviderClientOrderId = await ctx.db
        .query("orders")
        .withIndex("by_provider_client_order_id", (q) => q.eq("providerClientOrderId", args.identifier))
        .collect()
    const ownedByProviderClientOrderId = byProviderClientOrderId
        .find((order) => orderBelongsToAccount(order, args.app, args.accountId))
    if (ownedByProviderClientOrderId) {
        return ownedByProviderClientOrderId
    }

    const byProviderOrderId = await ctx.db
        .query("orders")
        .withIndex("by_provider_order_id", (q) => q.eq("providerOrderId", args.identifier))
        .collect()
    const ownedByProviderOrderId = byProviderOrderId
        .find((order) => orderBelongsToAccount(order, args.app, args.accountId))
    if (ownedByProviderOrderId) {
        return ownedByProviderOrderId
    }

    return await findOrderRowByAlias(ctx.db, {
        app: args.app,
        accountId: args.accountId,
        alias: args.identifier,
    })
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
        accountId: string
        strategyMap: Map<string, StrategyDoc>
        positionClosures: ProviderPositionClosureInput[]
        updatedAt: number
    }
): Promise<ProviderClosePositionCandidate[]> {
    if (args.app !== "mt5") {
        return []
    }

    const candidates: ProviderClosePositionCandidate[] = []
    const seenPositionKeys = new Set<string>()
    const history = await ctx.db
        .query("provider_position_history")
        .withIndex("by_app_account_retained_until", (q) =>
            q
                .eq("app", args.app)
                .eq("accountId", args.accountId)
                .gte("retainedUntil", args.updatedAt)
        )
        .collect()

    for (const position of history) {
        if (
            position.retainedUntil < args.updatedAt ||
            position.ownershipStatus !== "owned" ||
            position.expectedExternal === true ||
            position.strategyId === undefined ||
            !args.strategyMap.has(String(position.strategyId))
        ) {
            continue
        }

        seenPositionKeys.add(position.positionKey)
        candidates.push({
            strategyId: position.strategyId,
            accountId: position.accountId,
            instrument: position.instrument,
            side: position.side,
            quantity: position.quantity,
            entryPrice: position.entryPrice,
            providerPositionId: position.providerPositionId,
            positionKey: position.positionKey,
            syncedAt: position.lastSeenAt,
            metadata: position.metadata,
        })
    }

    if (args.positionClosures.length === 0) {
        return candidates
    }

    const closureIdentityCandidates = new Set<string>()
    for (const closure of args.positionClosures) {
        for (const identifier of buildPositionClosureIdentityCandidates(closure)) {
            closureIdentityCandidates.add(identifier)
        }
    }

    const seenOrderIds = new Set<string>()

    for (const order of await findMT5EntryOrdersByClosureIdentity(ctx, {
        app: args.app,
        accountId: args.accountId,
        strategyMap: args.strategyMap,
        closureIdentityCandidates,
        seenOrderIds,
    })) {
        seenOrderIds.add(order.orderId)
        const candidate = resolveMT5HistoricProviderCloseCandidate(order)
        if (candidate && !seenPositionKeys.has(candidate.positionKey)) {
            seenPositionKeys.add(candidate.positionKey)
            candidates.push(candidate)
        }
    }

    for (const identifier of closureIdentityCandidates) {
        const order = await findCloseOrderByIdentifier(ctx, {
            app: args.app,
            accountId: args.accountId,
            identifier,
        })
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
        if (candidate && !seenPositionKeys.has(candidate.positionKey)) {
            seenPositionKeys.add(candidate.positionKey)
            candidates.push(candidate)
        }
    }

    return candidates
}

async function resolveFaultBackedProviderCloseCandidates(
    ctx: PortfolioMutationCtx,
    args: {
        app: Doc<"strategies">["app"]
        accountId: string
        strategyMap: Map<string, StrategyDoc>
    }
): Promise<ProviderClosePositionCandidate[]> {
    const faults = [
        ...await collectExecutionSafetyFaultsByBlockedState(ctx, args, true),
        ...await collectExecutionSafetyFaultsByBlockedState(ctx, args, false),
    ]
    const candidates: ProviderClosePositionCandidate[] = []
    const seenPositionKeys = new Set<string>()

    for (const fault of faults) {
        if (
            fault.category !== "accounting_mismatch" ||
            !fault.strategyId ||
            !args.strategyMap.has(String(fault.strategyId)) ||
            !fault.message.includes("disappeared from") ||
            !fault.message.includes("without close evidence")
        ) {
            continue
        }

        const payload = parseJson<Record<string, unknown>>(fault.providerPayload)
        const instrument = readIdentifier(payload?.instrument) ?? fault.instrument
        const side = readProviderPositionSide(payload?.side)
        const quantity = readFinitePayloadNumber(payload?.quantity)
        const entryPrice = readFinitePayloadNumber(payload?.entryPrice)
        if (!instrument || !side || quantity === undefined || entryPrice === undefined) {
            continue
        }

        const positionKey = readIdentifier(payload?.positionKey) ?? `${instrument}:${side}`
        if (seenPositionKeys.has(positionKey)) {
            continue
        }

        const providerPositionId = resolveProviderPositionIdFromFaultPayload(instrument, positionKey, payload)
        seenPositionKeys.add(positionKey)
        candidates.push({
            strategyId: fault.strategyId,
            runId: fault.runId,
            accountId: args.accountId,
            instrument,
            side,
            quantity,
            entryPrice,
            providerPositionId,
            positionKey,
            syncedAt: 0,
            metadata: JSON.stringify({
                source: "execution_safety_fault",
                positionKey,
                providerPositionId,
                safetyFaultId: String(fault._id),
            }),
        })
    }

    return candidates
}

async function collectExecutionSafetyFaultsByBlockedState(
    ctx: PortfolioMutationCtx,
    args: {
        app: Doc<"strategies">["app"]
        accountId: string
    },
    blocked: boolean
): Promise<Array<Doc<"execution_safety_faults">>> {
    return await ctx.db
        .query("execution_safety_faults")
        .withIndex("by_app_account_blocked", (q) =>
            q.eq("app", args.app).eq("accountId", args.accountId).eq("blocked", blocked)
        )
        .collect()
}

function resolveProviderPositionIdFromFaultPayload(
    instrument: string,
    positionKey: string,
    payload: Record<string, unknown> | undefined
): string | undefined {
    const explicit = readIdentifier(payload?.providerPositionId)
    if (explicit) {
        return explicit
    }

    const prefix = `${instrument}:`
    if (!positionKey.startsWith(prefix)) {
        return undefined
    }

    const suffix = positionKey.slice(prefix.length)
    return suffix && suffix !== "long" && suffix !== "short" ? suffix : undefined
}

function readProviderPositionSide(value: unknown): "long" | "short" | undefined {
    return value === "long" || value === "short" ? value : undefined
}

function readFinitePayloadNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value
    }

    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number(value)
        return Number.isFinite(parsed) ? parsed : undefined
    }

    return undefined
}

async function findMT5EntryOrdersByClosureIdentity(
    ctx: PortfolioMutationCtx,
    args: {
        app: Doc<"strategies">["app"]
        accountId: string
        strategyMap: Map<string, StrategyDoc>
        closureIdentityCandidates: Set<string>
        seenOrderIds: Set<string>
    }
): Promise<Doc<"orders">[]> {
    const matches: Doc<"orders">[] = []

    for (const strategy of args.strategyMap.values()) {
        if (strategy.app !== args.app || strategy.accountId !== args.accountId) {
            continue
        }

        for (const status of HISTORIC_MT5_ENTRY_ORDER_STATUSES) {
            const orders = await ctx.db
                .query("orders")
                .withIndex("by_strategy_status", (q) =>
                    q.eq("strategyId", strategy._id).eq("status", status)
                )
                .collect()

            for (const order of orders) {
                if (
                    args.seenOrderIds.has(order.orderId) ||
                    !isEntryLikeOrder(order) ||
                    !isTerminalHistoricOrderStatus(order.status) ||
                    !orderBelongsToAccount(order, args.app, args.accountId) ||
                    !hasSharedProviderPositionIdentity(
                        buildMT5HistoricOrderIdentityCandidates(order),
                        args.closureIdentityCandidates
                    )
                ) {
                    continue
                }

                matches.push(order)
            }
        }
    }

    return matches
}

async function resolveHistoricOKXProviderCloseCandidates(
    ctx: PortfolioMutationCtx,
    args: {
        app: Doc<"strategies">["app"]
        accountId: string
        strategyMap: Map<string, StrategyDoc>
        existingProviderPositions: Doc<"provider_positions">[]
        positionClosures: ProviderPositionClosureInput[]
        updatedAt: number
    }
): Promise<ProviderClosePositionCandidate[]> {
    if (args.app !== "okx-swap") {
        return []
    }

    const existingPositionKeys = new Set(args.existingProviderPositions.map((position) => position.positionKey))
    const history = await ctx.db
        .query("provider_position_history")
        .withIndex("by_app_account_retained_until", (q) =>
            q
                .eq("app", args.app)
                .eq("accountId", args.accountId)
                .gte("retainedUntil", args.updatedAt)
        )
        .collect()

    return history
        .filter((position) =>
            position.retainedUntil >= args.updatedAt &&
            position.ownershipStatus === "owned" &&
            position.expectedExternal !== true &&
            position.strategyId !== undefined &&
            args.strategyMap.has(String(position.strategyId)) &&
            !existingPositionKeys.has(position.positionKey)
        )
        .map((position) => ({
            strategyId: position.strategyId!,
            accountId: position.accountId,
            instrument: position.instrument,
            side: position.side,
            quantity: position.quantity,
            entryPrice: position.entryPrice,
            metadata: position.metadata,
            providerPositionId: position.providerPositionId,
            positionKey: position.positionKey,
            syncedAt: position.lastSeenAt,
        }))
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
    if (!providerPositionId || !side || entryPrice === undefined || !order.accountId) {
        return undefined
    }

    const positionKey = `${order.instrument}:${providerPositionId}`
    return {
        strategyId: order.strategyId,
        runId: order.runId,
        accountId: order.accountId,
        instrument: order.instrument,
        side,
        quantity: order.filledQuantity > 0 ? order.filledQuantity : order.quantity,
        entryPrice,
        providerPositionId,
        positionKey,
        syncedAt: Math.min(order.submittedAt, order.updatedAt),
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
    const metadata = readOrderIntentMetadata(order)
    for (const value of [
        metadata?.positionId,
        metadata?.providerPositionId,
        metadata?.identifier,
    ]) {
        const identifier = readIdentifier(value)
        if (identifier && /^\d+$/.test(identifier)) {
            return identifier
        }
    }

    for (const identifier of getOrderProviderIdentifiers(order)) {
        if (/^\d+$/.test(identifier)) {
            return identifier
        }
    }

    return undefined
}

function buildMT5HistoricOrderIdentityCandidates(order: Doc<"orders">): Set<string> {
    const identifiers = new Set<string>()
    const metadata = readOrderIntentMetadata(order)

    for (const identifier of getOrderProviderIdentifiers(order)) {
        addKnownIdentifier(identifiers, identifier)
    }

    addKnownIdentifier(identifiers, metadata?.positionId)
    addKnownIdentifier(identifiers, metadata?.providerPositionId)
    addKnownIdentifier(identifiers, metadata?.identifier)
    addKnownIdentifier(identifiers, metadata?.ticket)
    addKnownIdentifier(identifiers, metadata?.orderId)

    return identifiers
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
    const orders = await collectRecentStrategyOrdersByStatuses(ctx, {
        strategyId: args.strategyId,
        statuses: ["filled", "partially_filled"],
        updatedAtFrom: args.closure.closedAt - HISTORIC_CANONICAL_CLOSE_MATCH_WINDOW_MS,
        updatedAtTo: args.closure.closedAt + PROVIDER_CLOSURE_TIME_SKEW_MS,
    })
    const closureIds = buildPositionClosureIdentityCandidates(args.closure)

    return orders.find((order) =>
        order.action === "close" &&
        order.instrument === args.closure.instrument &&
        !isSyntheticProviderCloseOrder(order) &&
        hasSharedProviderPositionIdentity(buildOrderCloseIdentityCandidates(order), closureIds)
    )
}

async function collectRecentStrategyOrdersByStatuses(
    ctx: PortfolioMutationCtx,
    args: {
        strategyId: Id<"strategies">
        statuses: Array<Doc<"orders">["status"]>
        updatedAtFrom: number
        updatedAtTo: number
    }
): Promise<Array<Doc<"orders">>> {
    return (
        await Promise.all(args.statuses.map(async (status) => await ctx.db
            .query("orders")
            .withIndex("by_strategy_status_updated_at", (q) =>
                q
                    .eq("strategyId", args.strategyId)
                    .eq("status", status)
                    .gte("updatedAt", args.updatedAtFrom)
                    .lte("updatedAt", args.updatedAtTo)
            )
            .collect()))
    ).flat()
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

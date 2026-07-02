import { isSettlementCurrency } from "@valiq-trading/core"
import type { Doc, Id } from "../../_generated/dataModel"
import type {
    PortfolioMutationCtx,
    ProviderPositionClosureInput,
} from "./portfolioTypes"
import { appendOrderTransition, patchOrderRowFromDoc, upsertOrderRow } from "./orders"
import { parseJson, readMetadataRecord, readOrderIntentRecord } from "./portfolioUtils"
import {
    buildProviderPositionIdentityCandidates,
    buildPositionClosureIdentityCandidates,
    buildProviderCloseOrderId,
    buildPositionClosureKey,
    hasSharedProviderPositionIdentity,
    isRetiredProviderCloseOrder,
    isSyntheticProviderCloseOrder,
    orderBelongsToAccount,
    readIdentifier,
    readOrderIntentMetadata,
    resolveProviderClosureDealId,
    resolveProviderClosureDealIdFromMetadata,
    resolveProviderCloseOrderProviderId,
    type ProviderClosePositionCandidate,
} from "./portfolioCloseIdentity"
import { INFERRED_FILL_ACCOUNTING_FAULT_PREFIX } from "./portfolioInferredFillFaults"

const UNATTRIBUTED_CLOSURE_FAULT_PREFIX = "Provider reconciliation found an unattributed money-bearing close:"

export async function attachClosureToCanonicalCloseOrder(
    ctx: PortfolioMutationCtx,
    args: {
        order: Doc<"orders">
        position?: ProviderClosePositionCandidate
        closure: ProviderPositionClosureInput
        updatedAt: number
    }
): Promise<void> {
    if (!args.order.accountId) {
        throw new Error(`Cannot attach provider closure to order without accountId: ${args.order.orderId}`)
    }

    await recordNonSettlementFeeFaultIfNeeded(ctx, {
        app: args.order.app ?? args.order.venue as Doc<"strategies">["app"],
        accountId: args.order.accountId,
        strategyId: args.order.strategyId,
        runId: args.order.runId,
        instrument: args.order.instrument,
        orderId: args.order.orderId,
        providerOrderId: resolveProviderCloseOrderProviderId(args.closure),
        closure: args.closure,
        updatedAt: args.updatedAt,
    })
    await recordProviderClosureMissingAccountingFaultIfNeeded(ctx, {
        app: args.order.app ?? args.order.venue as Doc<"strategies">["app"],
        accountId: args.order.accountId,
        strategyId: args.order.strategyId,
        runId: args.order.runId,
        instrument: args.order.instrument,
        orderId: args.order.orderId,
        providerOrderId: resolveProviderCloseOrderProviderId(args.closure),
        closure: args.closure,
        updatedAt: args.updatedAt,
    })

    if (args.order.status !== "filled" || canonicalCloseNeedsProviderClosureAttach(args.order, args.closure)) {
        await attachProviderClosureToCanonicalCloseOrder(ctx, args)
    }

    await resolveProviderClosureFaultsAfterCanonicalAttach(ctx, {
        app: args.order.app ?? args.order.venue as Doc<"strategies">["app"],
        accountId: args.order.accountId,
        order: args.order,
        position: args.position,
        closure: args.closure,
        updatedAt: args.updatedAt,
    })

    const app = args.order.app ?? args.order.venue as Doc<"strategies">["app"]
    const duplicateSynthetic = await resolveExistingProviderCloseOrder(ctx, {
        app,
        accountId: args.order.accountId,
        syntheticOrderId: args.position && args.order.app
            ? buildProviderCloseOrderId(args.order.app, args.position, args.closure)
            : undefined,
        providerOrderId: resolveProviderCloseOrderProviderId(args.closure),
    })
    if (duplicateSynthetic && duplicateSynthetic.orderId !== args.order.orderId && duplicateSynthetic.status !== "cancelled") {
        await retireDuplicateProviderCloseOrder(ctx, {
            app,
            accountId: args.order.accountId,
            order: duplicateSynthetic,
            canonicalOrderId: args.order.orderId,
            closure: args.closure,
            updatedAt: args.updatedAt,
        })
    }
}

async function resolveProviderClosureFaultsAfterCanonicalAttach(
    ctx: PortfolioMutationCtx,
    args: {
        app: Doc<"strategies">["app"]
        accountId: string
        order: Doc<"orders">
        position?: ProviderClosePositionCandidate
        closure: ProviderPositionClosureInput
        updatedAt: number
    }
): Promise<void> {
    const faults = await ctx.db
        .query("execution_safety_faults")
        .withIndex("by_app_account_blocked", (q) =>
            q.eq("app", args.app).eq("accountId", args.accountId).eq("blocked", true)
        )
        .collect()

    const resolvedByStrategy = new Map<string, { strategyId: Id<"strategies">; count: number }>()
    const resolutionNote = `Provider closure attached to canonical close order ${args.order.orderId}`

    for (const fault of faults) {
        if (
            fault.category === "accounting_mismatch" &&
            fault.canonicalOrderId === args.order.orderId &&
            fault.message.startsWith(INFERRED_FILL_ACCOUNTING_FAULT_PREFIX)
        ) {
            await resolveProviderClosureFault(ctx, {
                fault,
                updatedAt: args.updatedAt,
                resolutionNote,
                resolvedByStrategy,
            })
            continue
        }

        if (providerClosureResolvesEntryAccountingFault(fault, args)) {
            await resolveProviderClosureFault(ctx, {
                fault,
                updatedAt: args.updatedAt,
                resolutionNote,
                resolvedByStrategy,
            })
            continue
        }

        if (providerClosureResolvesVanishedPositionFault(fault, args)) {
            await resolveProviderClosureFault(ctx, {
                fault,
                updatedAt: args.updatedAt,
                resolutionNote,
                resolvedByStrategy,
            })
            continue
        }

        if (providerClosureResolvesProviderPositionProtectionFault(fault, args)) {
            await resolveProviderClosureFault(ctx, {
                fault,
                updatedAt: args.updatedAt,
                resolutionNote,
                resolvedByStrategy,
            })
            continue
        }

        if (
            fault.category === "unattributed_closure" &&
            fault.instrument === args.closure.instrument &&
            providerClosureFaultMatchesClosure(fault, args.closure)
        ) {
            await resolveProviderClosureFault(ctx, {
                fault,
                updatedAt: args.updatedAt,
                resolutionNote,
                resolvedByStrategy,
            })
        }
    }

    for (const resolved of resolvedByStrategy.values()) {
        await ctx.db.insert("alerts", {
            strategyId: resolved.strategyId,
            app: args.app,
            severity: "info",
            message: `[execution-safety] Provider closure replay cleared ${resolved.count} fault(s) after attaching broker accounting to ${args.order.orderId}`,
            acknowledged: false,
            timestamp: args.updatedAt,
        })
    }
}

function providerClosureResolvesEntryAccountingFault(
    fault: Doc<"execution_safety_faults">,
    args: {
        order: Doc<"orders">
        position?: ProviderClosePositionCandidate
        closure: ProviderPositionClosureInput
    }
): boolean {
    if (
        fault.category !== "accounting_mismatch" ||
        fault.strategyId !== args.order.strategyId ||
        fault.instrument !== args.closure.instrument ||
        !fault.message.includes("filled entry order without provider accounting metadata") ||
        !closureHasProviderAccountingMetadata(args.closure)
    ) {
        return false
    }

    const faultIdentifiers = buildFaultOrderIdentifiers(fault)
    if (faultIdentifiers.size === 0) {
        return false
    }

    return buildClosureSourceEntryIdentifiers(args).some((identifier) => faultIdentifiers.has(identifier))
}

function providerClosureResolvesVanishedPositionFault(
    fault: Doc<"execution_safety_faults">,
    args: {
        order: Doc<"orders">
        position?: ProviderClosePositionCandidate
        closure: ProviderPositionClosureInput
    }
): boolean {
    if (
        fault.category !== "accounting_mismatch" ||
        fault.strategyId !== args.order.strategyId ||
        fault.instrument !== args.closure.instrument ||
        !fault.message.includes("disappeared from") ||
        !fault.message.includes("without close evidence") ||
        !closureHasProviderAccountingMetadata(args.closure)
    ) {
        return false
    }

    const payload = parseJson<Record<string, unknown>>(fault.providerPayload)
    if (!args.position) {
        return true
    }

    const positionKey = readIdentifier(payload?.positionKey)
    if (positionKey && positionKey !== args.position.positionKey) {
        return false
    }

    const side = readIdentifier(payload?.side)
    if (side && side !== args.position.side) {
        return false
    }

    return true
}

function providerClosureResolvesProviderPositionProtectionFault(
    fault: Doc<"execution_safety_faults">,
    args: {
        order: Doc<"orders">
        position?: ProviderClosePositionCandidate
        closure: ProviderPositionClosureInput
    }
): boolean {
    const payload = parseJson<Record<string, unknown>>(fault.providerPayload)

    if (
        !isProviderPositionProtectionFault(fault, payload) ||
        fault.strategyId !== args.order.strategyId ||
        fault.instrument !== args.closure.instrument ||
        !closureHasProviderAccountingMetadata(args.closure)
    ) {
        return false
    }

    const side = readProviderPositionSide(payload?.positionSide ?? payload?.side)
    if (side && side !== args.closure.side) {
        return false
    }

    const faultIdentifiers = buildFaultProviderPositionIdentifiers(fault, payload)
    if (faultIdentifiers.size === 0) {
        return false
    }

    if (
        hasSharedProviderPositionIdentity(
            faultIdentifiers,
            buildPositionClosureIdentityCandidates(args.closure)
        )
    ) {
        return true
    }

    return args.position !== undefined &&
        hasSharedProviderPositionIdentity(
            faultIdentifiers,
            buildProviderPositionIdentityCandidates(args.position)
        )
}

function isProviderPositionProtectionFault(
    fault: Doc<"execution_safety_faults">,
    payload: Record<string, unknown> | undefined
): boolean {
    if (fault.category === "position_not_found_yet") {
        return true
    }

    return fault.category === "unknown" &&
        readIdentifier(payload?.phase) === "updateProtectionOrders" &&
        fault.message.includes("/api/v5/trade/order-algo")
}

function buildFaultProviderPositionIdentifiers(
    fault: Doc<"execution_safety_faults">,
    payload: Record<string, unknown> | undefined
): Set<string> {
    const identifiers = new Set<string>()
    addIdentifier(identifiers, payload?.providerPositionId)
    addIdentifier(identifiers, payload?.providerPositionKey)
    addIdentifier(identifiers, payload?.positionId)
    addIdentifier(identifiers, payload?.positionKey)
    addIdentifier(identifiers, payload?.posId)
    addIdentifier(identifiers, payload?.identifier)
    addIdentifier(identifiers, fault.providerOrderId)
    for (const alias of fault.providerOrderAliases ?? []) {
        addIdentifier(identifiers, alias)
    }
    return identifiers
}

function readProviderPositionSide(value: unknown): "long" | "short" | undefined {
    return value === "long" || value === "short" ? value : undefined
}

function buildFaultOrderIdentifiers(fault: Doc<"execution_safety_faults">): Set<string> {
    const identifiers = new Set<string>()
    addIdentifier(identifiers, fault.canonicalOrderId)
    addIdentifier(identifiers, fault.providerOrderId)
    addIdentifier(identifiers, fault.providerClientOrderId)
    addIdentifier(identifiers, fault.signedOrderFingerprint)
    for (const alias of fault.providerOrderAliases ?? []) {
        addIdentifier(identifiers, alias)
    }
    return identifiers
}

function buildClosureSourceEntryIdentifiers(args: {
    order: Doc<"orders">
    position?: ProviderClosePositionCandidate
    closure: ProviderPositionClosureInput
}): string[] {
    const identifiers = new Set<string>()
    const closeMetadata = readOrderIntentMetadata(args.order)
    const positionMetadata = readMetadataRecord(args.position?.metadata)
    const closureMetadata = parseJson<Record<string, unknown>>(args.closure.metadata)
    const sourceOrder = args.position?.sourceOrder

    addIdentifier(identifiers, sourceOrder?.orderId)
    addIdentifier(identifiers, sourceOrder?.providerOrderId)
    addIdentifier(identifiers, sourceOrder?.providerClientOrderId)
    addIdentifier(identifiers, sourceOrder?.signedOrderFingerprint)
    for (const alias of sourceOrder?.providerOrderAliases ?? []) {
        addIdentifier(identifiers, alias)
    }

    addIdentifier(identifiers, args.position?.providerPositionId)
    addIdentifier(identifiers, positionMetadata?.providerOrderId)
    addIdentifier(identifiers, positionMetadata?.providerClientOrderId)
    addIdentifier(identifiers, positionMetadata?.sourceOrderId)
    addIdentifier(identifiers, positionMetadata?.orderId)
    addIdentifier(identifiers, closeMetadata?.providerOrderId)
    addIdentifier(identifiers, closeMetadata?.providerActivityId)
    addIdentifier(identifiers, closeMetadata?.activityId)
    addIdentifier(identifiers, closeMetadata?.providerClientOrderId)
    addIdentifier(identifiers, closeMetadata?.sourceOrderId)
    addIdentifier(identifiers, closeMetadata?.providerPositionId)
    addIdentifier(identifiers, closureMetadata?.providerOrderId)
    addIdentifier(identifiers, closureMetadata?.orderId)
    addIdentifier(identifiers, closureMetadata?.providerActivityId)
    addIdentifier(identifiers, closureMetadata?.activityId)
    addIdentifier(identifiers, closureMetadata?.positionId)
    addIdentifier(identifiers, closureMetadata?.providerPositionId)

    return Array.from(identifiers)
}

function closureHasProviderAccountingMetadata(closure: ProviderPositionClosureInput): boolean {
    const metadata = parseJson<Record<string, unknown>>(closure.metadata)
    return ACCUMULATED_PROVIDER_DEAL_FIELDS.some((field) => readFiniteMetadataNumber(metadata?.[field]) !== undefined)
}

function addIdentifier(identifiers: Set<string>, value: unknown): void {
    const identifier = readIdentifier(value)
    if (identifier) {
        identifiers.add(identifier)
    }
}

async function resolveProviderClosureFault(
    ctx: PortfolioMutationCtx,
    args: {
        fault: Doc<"execution_safety_faults">
        updatedAt: number
        resolutionNote: string
        resolvedByStrategy: Map<string, { strategyId: Id<"strategies">; count: number }>
    }
): Promise<void> {
    await ctx.db.patch(args.fault._id, {
        blocked: false,
        resolvedAt: args.updatedAt,
        resolutionNote: args.resolutionNote,
    })

    const entry = args.resolvedByStrategy.get(String(args.fault.strategyId)) ?? {
        strategyId: args.fault.strategyId,
        count: 0,
    }
    entry.count += 1
    args.resolvedByStrategy.set(String(args.fault.strategyId), entry)
}

function providerClosureFaultMatchesClosure(
    fault: Doc<"execution_safety_faults">,
    closure: ProviderPositionClosureInput
): boolean {
    if (!fault.message.startsWith(UNATTRIBUTED_CLOSURE_FAULT_PREFIX)) {
        return false
    }

    const payload = parseJson<{
        closure?: ProviderPositionClosureInput
    }>(fault.providerPayload)
    if (!payload?.closure) {
        return false
    }

    if (buildPositionClosureKey(payload.closure) === buildPositionClosureKey(closure)) {
        return true
    }

    return payload.closure.instrument === closure.instrument &&
        payload.closure.side === closure.side &&
        Math.abs(payload.closure.quantity - closure.quantity) <= 1e-9 &&
        hasSharedProviderPositionIdentity(
            buildPositionClosureIdentityCandidates(payload.closure),
            buildPositionClosureIdentityCandidates(closure)
        )
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
        app,
        accountId: position.accountId,
        syntheticOrderId,
        providerOrderId,
    })

    if (existingOrder && isRetiredProviderCloseOrder(existingOrder)) {
        return
    }

    const orderId = existingOrder?.orderId ?? syntheticOrderId
    const runId = existingOrder?.runId ?? args.runId
    await recordNonSettlementFeeFaultIfNeeded(ctx, {
        app,
        accountId: position.accountId,
        strategyId: position.strategyId,
        runId,
        instrument: position.instrument,
        orderId,
        providerOrderId,
        closure,
        updatedAt: args.updatedAt,
    })
    await recordProviderClosureMissingAccountingFaultIfNeeded(ctx, {
        app,
        accountId: position.accountId,
        strategyId: position.strategyId,
        runId,
        instrument: position.instrument,
        orderId,
        providerOrderId,
        closure,
        updatedAt: args.updatedAt,
    })

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
        accountId: position.accountId,
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

    const order = await ctx.db
        .query("orders")
        .withIndex("by_order_id", (q) => q.eq("orderId", orderId))
        .first()
    if (order) {
        await resolveProviderClosureFaultsAfterCanonicalAttach(ctx, {
            app,
            accountId: position.accountId,
            order,
            position,
            closure,
            updatedAt: args.updatedAt,
        })
    }

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
        accountId: position.accountId,
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

async function recordProviderClosureMissingAccountingFaultIfNeeded(
    ctx: PortfolioMutationCtx,
    args: {
        app: Doc<"strategies">["app"]
        accountId: string
        strategyId: Id<"strategies">
        runId: Id<"strategy_runs">
        instrument: string
        orderId: string
        providerOrderId?: string
        closure: ProviderPositionClosureInput
        updatedAt: number
    }
): Promise<void> {
    const metadata = parseJson<Record<string, unknown>>(args.closure.metadata)
    if (metadata?.providerAccountingMissing !== true) {
        return
    }

    const reason = typeof metadata.providerAccountingMissingReason === "string"
        ? metadata.providerAccountingMissingReason
        : "provider_closure_without_accounting_metadata"
    const message = `Provider closure for ${args.instrument} did not include complete provider accounting metadata`
    const existing = await ctx.db
        .query("execution_safety_faults")
        .withIndex("by_strategy_blocked", (q) => q.eq("strategyId", args.strategyId).eq("blocked", true))
        .collect()
    if (existing.some((fault) =>
        fault.category === "accounting_mismatch" &&
        fault.instrument === args.instrument &&
        fault.canonicalOrderId === args.orderId &&
        fault.message === message
    )) {
        return
    }

    await ctx.db.insert("execution_safety_faults", {
        strategyId: args.strategyId,
        app: args.app,
        accountId: args.accountId,
        instrument: args.instrument,
        category: "accounting_mismatch",
        message,
        providerPayload: JSON.stringify({
            closure: args.closure,
            metadata,
            reason,
        }),
        canonicalOrderId: args.orderId,
        providerOrderId: args.providerOrderId,
        runId: args.runId,
        blocked: true,
        occurredAt: args.updatedAt,
        resolvedAt: undefined,
        resolutionNote: undefined,
    })
    await ctx.db.insert("alerts", {
        strategyId: args.strategyId,
        app: args.app,
        severity: "critical",
        message,
        acknowledged: false,
        timestamp: args.updatedAt,
    })
}

async function recordNonSettlementFeeFaultIfNeeded(
    ctx: PortfolioMutationCtx,
    args: {
        app: Doc<"strategies">["app"]
        accountId: string
        strategyId: Id<"strategies">
        runId: Id<"strategy_runs">
        instrument: string
        orderId: string
        providerOrderId?: string
        closure: ProviderPositionClosureInput
        updatedAt: number
    }
): Promise<void> {
    const metadata = parseJson<Record<string, unknown>>(args.closure.metadata)
    const fee = readFiniteMetadataNumber(metadata?.fee)
    const feeCcy = typeof metadata?.feeCcy === "string" ? metadata.feeCcy.trim().toUpperCase() : undefined
    if (fee === undefined || fee === 0 || !feeCcy || isSettlementCurrency(feeCcy)) {
        return
    }

    const message = `Provider reported ${feeCcy} fee for ${args.instrument}; realized PnL cannot silently treat it as settlement currency`
    const existing = await ctx.db
        .query("execution_safety_faults")
        .withIndex("by_strategy_blocked", (q) => q.eq("strategyId", args.strategyId).eq("blocked", true))
        .collect()
    if (existing.some((fault) =>
        fault.category === "accounting_mismatch" &&
        fault.instrument === args.instrument &&
        fault.canonicalOrderId === args.orderId &&
        fault.message === message
    )) {
        return
    }

    await ctx.db.insert("execution_safety_faults", {
        strategyId: args.strategyId,
        app: args.app,
        accountId: args.accountId,
        instrument: args.instrument,
        category: "accounting_mismatch",
        message,
        providerPayload: JSON.stringify({
            closure: args.closure,
            metadata,
        }),
        canonicalOrderId: args.orderId,
        providerOrderId: args.providerOrderId,
        runId: args.runId,
        blocked: true,
        occurredAt: args.updatedAt,
        resolvedAt: undefined,
        resolutionNote: undefined,
    })
    await ctx.db.insert("alerts", {
        strategyId: args.strategyId,
        app: args.app,
        severity: "critical",
        message,
        acknowledged: false,
        timestamp: args.updatedAt,
    })
}

function readFiniteMetadataNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value
    }

    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value)
        return Number.isFinite(parsed) ? parsed : undefined
    }

    return undefined
}

export async function repairEntryOrderFromProviderClosure(
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
        reason: "Provider closure history proved this entry order filled before the broker-reported position close",
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
    const accounting = buildAccumulatedClosureAccounting(readOrderIntentMetadata(args.order) ?? {}, args.closure)
    const attachedQuantity = readFiniteMetadataNumber(accounting?.attachedQuantity)
    const filledQuantity = attachedQuantity !== undefined
        ? promoteToFilled
            ? attachedQuantity
            : Math.max(args.order.filledQuantity, attachedQuantity)
        : promoteToFilled
            ? args.closure.quantity
            : args.order.filledQuantity
    await patchOrderRowFromDoc(ctx, args.order, {
        providerOrderId: args.order.providerOrderId ?? resolveProviderCloseOrderProviderId(args.closure),
        providerOrderAliases: mergeClosureAliases(args.order, args.closure),
        status: "filled",
        filledQuantity,
        remainingQuantity: promoteToFilled || attachedQuantity !== undefined
            ? Math.max(args.order.quantity - filledQuantity, 0)
            : args.order.remainingQuantity,
        avgFillPrice: promoteToFilled
            ? args.closure.fillPrice
            : args.order.avgFillPrice ?? args.closure.fillPrice,
        updatedAt: args.closure.closedAt,
        intent: buildCanonicalCloseIntentWithProviderClosure(args.order, args.position, args.closure, accounting),
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

function mergeClosureAliases(
    order: Pick<Doc<"orders">, "orderId" | "providerOrderId" | "providerClientOrderId" | "providerOrderAliases">,
    closure: ProviderPositionClosureInput
): string[] {
    const metadata = parseJson<Record<string, unknown>>(closure.metadata)
    const aliases = new Set<string>(order.providerOrderAliases ?? [])

    addAlias(aliases, order.providerOrderId)
    addAlias(aliases, order.providerClientOrderId)
    addAlias(aliases, metadata?.providerOrderId)
    addAlias(aliases, metadata?.orderId)
    addAlias(aliases, metadata?.providerActivityId)
    addAlias(aliases, metadata?.activityId)
    addAlias(aliases, metadata?.triggeredOrderId)
    addAlias(aliases, metadata?.clientOrderId)
    addAlias(aliases, metadata?.algoId)
    addAlias(aliases, metadata?.algoClOrdId)
    addAlias(aliases, metadata?.actualOrdId)
    if (Array.isArray(metadata?.providerOrderAliases)) {
        for (const alias of metadata.providerOrderAliases) {
            addAlias(aliases, alias)
        }
    }

    aliases.delete(order.orderId)
    if (order.providerClientOrderId) {
        aliases.delete(order.providerClientOrderId)
    }

    return Array.from(aliases).sort((left, right) => left.localeCompare(right))
}

function addAlias(aliases: Set<string>, value: unknown): void {
    if (typeof value === "string" && value.trim()) {
        aliases.add(value.trim())
    }
}

const ACCUMULATED_PROVIDER_DEAL_FIELDS = ["fillPnl", "profit", "commission", "swap", "fee"] as const

function canonicalCloseNeedsProviderClosureAttach(
    order: Doc<"orders">,
    closure: ProviderPositionClosureInput
): boolean {
    const metadata = readOrderIntentMetadata(order)
    if (metadata?.providerReconciledClose !== true) {
        return true
    }

    const dealId = resolveProviderClosureDealId(closure)
    if (dealId) {
        return !readAttachedProviderDealIds(metadata).includes(dealId)
    }

    const closureMetadata = parseJson<Record<string, unknown>>(closure.metadata)
    const closurePnl = typeof closureMetadata?.fillPnl === "number"
        ? closureMetadata.fillPnl
        : closureMetadata?.profit
    return typeof closurePnl === "number" && metadata.fillPnl !== closurePnl
}

function readAttachedProviderDealIds(metadata: Record<string, unknown>): string[] {
    const raw = metadata.attachedProviderDealIds
    if (Array.isArray(raw)) {
        const dealIds: string[] = []
        for (const value of raw) {
            const dealId = readIdentifier(value)
            if (dealId) {
                dealIds.push(dealId)
            }
        }
        return dealIds
    }

    if (metadata.providerReconciledClose === true) {
        const legacyDealId = resolveProviderClosureDealIdFromMetadata(metadata)
        return legacyDealId ? [legacyDealId] : []
    }

    return []
}

function buildAccumulatedClosureAccounting(
    currentMetadata: Record<string, unknown>,
    closure: ProviderPositionClosureInput
): Record<string, unknown> | undefined {
    const dealId = resolveProviderClosureDealId(closure)
    if (!dealId) {
        return undefined
    }

    const attachedDealIds = readAttachedProviderDealIds(currentMetadata)
    if (attachedDealIds.includes(dealId)) {
        const preserved: Record<string, unknown> = {
            attachedProviderDealIds: attachedDealIds,
        }
        for (const field of [...ACCUMULATED_PROVIDER_DEAL_FIELDS, "attachedQuantity"]) {
            if (currentMetadata[field] !== undefined) {
                preserved[field] = currentMetadata[field]
            }
        }
        return preserved
    }

    const closureMetadata = parseJson<Record<string, unknown>>(closure.metadata)
    const accumulated: Record<string, unknown> = {
        attachedProviderDealIds: [...attachedDealIds, dealId],
        attachedQuantity: (readFiniteMetadataNumber(currentMetadata.attachedQuantity) ?? 0) + closure.quantity,
    }
    for (const field of ACCUMULATED_PROVIDER_DEAL_FIELDS) {
        const prior = attachedDealIds.length > 0
            ? readFiniteMetadataNumber(currentMetadata[field])
            : undefined
        const incoming = readFiniteMetadataNumber(closureMetadata?.[field])
        if (prior !== undefined || incoming !== undefined) {
            accumulated[field] = (prior ?? 0) + (incoming ?? 0)
        }
    }

    return accumulated
}

async function resolveExistingProviderCloseOrder(
    ctx: PortfolioMutationCtx,
    args: {
        app: Doc<"strategies">["app"]
        accountId: string
        syntheticOrderId?: string
        providerOrderId?: string
    }
): Promise<Doc<"orders"> | null> {
    if (args.syntheticOrderId) {
        const bySyntheticOrderId = await ctx.db
            .query("orders")
            .withIndex("by_order_id", (q) => q.eq("orderId", args.syntheticOrderId!))
            .collect()
        const owned = bySyntheticOrderId.find((order) => orderBelongsToAccount(order, args.app, args.accountId))
        if (owned) {
            return owned
        }
    }

    if (!args.providerOrderId) {
        return null
    }

    const providerOrderId = args.providerOrderId
    const byProviderOrderId = await ctx.db
        .query("orders")
        .withIndex("by_provider_order_id", (q) => q.eq("providerOrderId", providerOrderId))
        .collect()

    return byProviderOrderId.find((order) =>
        orderBelongsToAccount(order, args.app, args.accountId) &&
        isSyntheticProviderCloseOrder(order)
    ) ?? null
}

function buildCanonicalCloseIntentWithProviderClosure(
    order: Doc<"orders">,
    position: ProviderClosePositionCandidate | undefined,
    closure: ProviderPositionClosureInput,
    accounting: Record<string, unknown> | undefined
): Record<string, unknown> {
    const intent = readOrderIntentRecord(order.intent) ?? {}
    const currentMetadata = readOrderIntentMetadata(order) ?? {}
    const metadata = {
        ...currentMetadata,
        ...readMetadataRecord(position?.metadata),
        ...parseJson<Record<string, unknown>>(closure.metadata),
        ...accounting,
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
        app: Doc<"strategies">["app"]
        accountId: string
        order: Doc<"orders">
        canonicalOrderId: string
        closure: ProviderPositionClosureInput
        updatedAt: number
    }
): Promise<void> {
    if (!orderBelongsToAccount(args.order, args.app, args.accountId)) {
        return
    }

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

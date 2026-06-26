import type { Doc } from "../../_generated/dataModel"
import {
    isSettlementCurrency,
    resolveOrderRealizedPnl,
} from "@valiq-trading/core"
import { incrementControlPlaneMetric } from "../controlPlaneMetrics"
import type { AccountPnlEventInput, PortfolioMutationCtx } from "./portfolioTypes"
import {
    almostEqual,
    hasNonZeroProviderAccountingMetadata,
    readOrderIntentRecord,
} from "./portfolioUtils"

type AccountSnapshotDoc = Doc<"account_snapshots">

const MONEY_LEVEL_RECONCILIATION_FAULT_PREFIX = "Money-level reconciliation mismatch:"
const INFERRED_ENTRY_FILL_ACCOUNTING_FAULT_MESSAGE = "Provider reconciliation inferred a filled entry order without provider accounting metadata"
const INFERRED_CLOSE_FILL_ACCOUNTING_FAULT_MESSAGE = "Provider reconciliation inferred a filled close order without provider accounting metadata"
const INFERRED_CLOSE_AUDIT_MATCH_WINDOW_MS = 24 * 60 * 60 * 1000

export async function reconcileAccountMoney(
    ctx: PortfolioMutationCtx,
    args: {
        app: Doc<"strategies">["app"]
        accountId: string
        venue: string
        strategies: Doc<"strategies">[]
        currentAccountState: {
            equity?: number
            openPnl: number
        }
        accountPnlEvents: AccountPnlEventInput[]
        updatedAt: number
    }
): Promise<{
    eventWriteStats: { inserted: number; patched: number; unchanged: number }
    moneyAuditMismatches: string[]
}> {
    const previousAccountSnapshot = await resolveLatestAccountSnapshot(ctx, args.app, args.accountId)
    const eventWriteStats = await upsertAccountPnlEvents(ctx, {
        app: args.app,
        accountId: args.accountId,
        venue: args.venue,
        events: args.accountPnlEvents,
        syncedAt: args.updatedAt,
    })

    await recordNonSettlementPnlEventFaults(ctx, {
        app: args.app,
        accountId: args.accountId,
        strategies: args.strategies,
        events: args.accountPnlEvents,
        updatedAt: args.updatedAt,
    })

    const moneyAuditMismatches = await runMoneyLevelReconciliationAudit(ctx, {
        app: args.app,
        accountId: args.accountId,
        venue: args.venue,
        previousSnapshot: previousAccountSnapshot,
        currentAccountState: args.currentAccountState,
        accountPnlEvents: args.accountPnlEvents,
        updatedAt: args.updatedAt,
    })

    return {
        eventWriteStats,
        moneyAuditMismatches,
    }
}

async function resolveLatestAccountSnapshot(
    ctx: PortfolioMutationCtx,
    app: Doc<"strategies">["app"],
    accountId: string
): Promise<AccountSnapshotDoc | undefined> {
    const snapshot = await ctx.db
        .query("account_snapshots")
        .withIndex("by_app_account_timestamp", (q) => q.eq("app", app).eq("accountId", accountId))
        .order("desc")
        .first()

    return snapshot ?? undefined
}

async function upsertAccountPnlEvents(
    ctx: PortfolioMutationCtx,
    args: {
        app: Doc<"strategies">["app"]
        accountId: string
        venue: string
        events: AccountPnlEventInput[]
        syncedAt: number
    }
): Promise<{ inserted: number; patched: number; unchanged: number }> {
    let inserted = 0
    let patched = 0
    let unchanged = 0

    for (const event of args.events) {
        const existing = await ctx.db
            .query("account_pnl_events")
            .withIndex("by_app_account_provider_event_id", (q) =>
                q.eq("app", args.app).eq("accountId", args.accountId).eq("providerEventId", event.providerEventId)
            )
            .first()

        if (existing) {
            const patch = buildAccountPnlEventProviderTruthPatch(existing, event, args.syncedAt)
            if (patch) {
                await ctx.db.patch(existing._id, patch)
                patched += 1
            } else {
                unchanged += 1
            }
            continue
        }

        await ctx.db.insert("account_pnl_events", {
            app: args.app,
            accountId: args.accountId,
            venue: args.venue,
            providerEventId: event.providerEventId,
            eventType: event.eventType,
            instrument: event.instrument,
            amount: event.amount,
            currency: event.currency,
            occurredAt: event.occurredAt,
            metadata: event.metadata,
            syncedAt: args.syncedAt,
        })
        inserted += 1
    }

    return { inserted, patched, unchanged }
}

function buildAccountPnlEventProviderTruthPatch(
    existing: Doc<"account_pnl_events">,
    event: AccountPnlEventInput,
    syncedAt: number
): Partial<Doc<"account_pnl_events">> | undefined {
    const patch = {
        eventType: event.eventType,
        instrument: event.instrument,
        amount: event.amount,
        currency: event.currency,
        occurredAt: event.occurredAt,
        metadata: event.metadata,
        syncedAt,
    }

    return existing.eventType !== patch.eventType ||
        existing.instrument !== patch.instrument ||
        existing.amount !== patch.amount ||
        existing.currency !== patch.currency ||
        existing.occurredAt !== patch.occurredAt ||
        existing.metadata !== patch.metadata
        ? patch
        : undefined
}

async function recordNonSettlementPnlEventFaults(
    ctx: PortfolioMutationCtx,
    args: {
        app: Doc<"strategies">["app"]
        accountId: string
        strategies: Doc<"strategies">[]
        events: AccountPnlEventInput[]
        updatedAt: number
    }
): Promise<void> {
    const nonSettlementEvents = args.events.filter((event) => !isSettlementCurrency(event.currency))
    if (nonSettlementEvents.length === 0) {
        return
    }

    const existingFaults = await ctx.db
        .query("execution_safety_faults")
        .withIndex("by_app_account_blocked", (q) =>
            q.eq("app", args.app).eq("accountId", args.accountId).eq("blocked", true)
        )
        .collect()

    for (const event of nonSettlementEvents) {
        const message = `Account PnL event ${event.providerEventId} (${event.eventType}) is denominated in ${event.currency}, not the settlement currency; it is excluded from money-level reconciliation until converted`
        for (const strategy of args.strategies) {
            const duplicate = existingFaults.some((fault) =>
                fault.strategyId === strategy._id &&
                fault.category === "accounting_mismatch" &&
                fault.message === message
            )
            if (duplicate) {
                continue
            }

            await ctx.db.insert("execution_safety_faults", {
                strategyId: strategy._id,
                app: args.app,
                accountId: args.accountId,
                instrument: event.instrument ?? "account",
                category: "accounting_mismatch",
                message,
                providerPayload: JSON.stringify(event),
                blocked: true,
                occurredAt: args.updatedAt,
                resolvedAt: undefined,
            })
        }
    }
}

async function runMoneyLevelReconciliationAudit(
    ctx: PortfolioMutationCtx,
    args: {
        app: Doc<"strategies">["app"]
        accountId: string
        venue: string
        previousSnapshot?: AccountSnapshotDoc
        currentAccountState: {
            equity?: number
            openPnl: number
        }
        accountPnlEvents: AccountPnlEventInput[]
        updatedAt: number
    }
): Promise<string[]> {
    const previous = args.previousSnapshot
    const currentEquity = args.currentAccountState.equity
    if (!previous || previous.equity === undefined || currentEquity === undefined) {
        return []
    }

    const equityDelta = currentEquity - previous.equity
    const openPnlDelta = args.currentAccountState.openPnl - previous.openPnl
    const attributedOrderPnl = await resolveAttributedOrderPnlSince(ctx, {
        app: args.app,
        accountId: args.accountId,
        since: previous.timestamp,
        until: args.updatedAt,
    })
    const accountEventPnl = args.accountPnlEvents
        .filter((event) =>
            isSettlementCurrency(event.currency) &&
            event.occurredAt > previous.timestamp &&
            event.occurredAt <= args.updatedAt
        )
        .reduce((sum, event) => sum + event.amount, 0)
    const explainedDelta = attributedOrderPnl + accountEventPnl + openPnlDelta
    const residual = equityDelta - explainedDelta
    const tolerance = Math.max(1, Math.abs(currentEquity) * 0.0001)

    if (Math.abs(residual) <= tolerance) {
        await resolveMoneyAuditMismatchFaults(ctx, {
            app: args.app,
            accountId: args.accountId,
            updatedAt: args.updatedAt,
        })
        return []
    }

    const message = [
        `${args.app} equity delta ${formatMoney(equityDelta)}`,
        `attributed realized ${formatMoney(attributedOrderPnl)}`,
        `account events ${formatMoney(accountEventPnl)}`,
        `open PnL delta ${formatMoney(openPnlDelta)}`,
        `residual ${formatMoney(residual)}`,
        `tolerance ${formatMoney(tolerance)}`,
    ].join(", ")

    await incrementControlPlaneMetric(ctx, {
        metric: "reconcile_provider_portfolio.money_audit_mismatch",
        app: args.app,
    })
    await ctx.db.insert("alerts", {
        app: args.app,
        severity: "warning",
        message: `[portfolio] ${args.app}:${args.accountId} money reconciliation mismatch: ${message}`,
        acknowledged: false,
        timestamp: args.updatedAt,
    })
    await recordMoneyAuditMismatchFaults(ctx, {
        ...args,
        message,
        equityDelta,
        attributedOrderPnl,
        accountEventPnl,
        openPnlDelta,
        residual,
        tolerance,
    })

    return [message]
}

async function resolveMoneyAuditMismatchFaults(
    ctx: PortfolioMutationCtx,
    args: {
        app: Doc<"strategies">["app"]
        accountId: string
        updatedAt: number
    }
): Promise<void> {
    const faults = await ctx.db
        .query("execution_safety_faults")
        .withIndex("by_app_account_blocked", (q) =>
            q.eq("app", args.app).eq("accountId", args.accountId).eq("blocked", true)
        )
        .collect()
    const openMoneyFaults = faults.filter(isOpenMoneyAuditMismatchFault)
    const openInferredFillFaults = faults.filter(isOpenInferredEntryFillAccountingFault)
    const openInferredCloseFaults = faults.filter(isOpenInferredCloseFillAccountingFault)
    if (openMoneyFaults.length === 0 && openInferredFillFaults.length === 0 && openInferredCloseFaults.length === 0) {
        return
    }

    const resolvedMoneyFaultsByStrategy = new Map<string, { strategyId: Doc<"strategies">["_id"]; count: number }>()
    for (const fault of openMoneyFaults) {
        await ctx.db.patch(fault._id, {
            blocked: false,
            resolvedAt: args.updatedAt,
            resolutionNote: "Provider money-level reconciliation audit passed within tolerance",
        })

        const entry = resolvedMoneyFaultsByStrategy.get(String(fault.strategyId)) ?? {
            strategyId: fault.strategyId,
            count: 0,
        }
        entry.count += 1
        resolvedMoneyFaultsByStrategy.set(String(fault.strategyId), entry)
    }

    const resolvedInferredFillFaultsByStrategy = new Map<string, { strategyId: Doc<"strategies">["_id"]; count: number }>()
    for (const fault of openInferredFillFaults) {
        await ctx.db.patch(fault._id, {
            blocked: false,
            resolvedAt: args.updatedAt,
            resolutionNote: "Provider money-level reconciliation audit passed within tolerance after inferred entry fill accounting gap",
        })

        const entry = resolvedInferredFillFaultsByStrategy.get(String(fault.strategyId)) ?? {
            strategyId: fault.strategyId,
            count: 0,
        }
        entry.count += 1
        resolvedInferredFillFaultsByStrategy.set(String(fault.strategyId), entry)
    }

    const resolvedInferredCloseFaultsByStrategy = new Map<string, { strategyId: Doc<"strategies">["_id"]; count: number }>()
    for (const fault of openInferredCloseFaults) {
        const auditedClose = await resolveAuditedCloseOrderForInferredCloseFault(ctx, fault)
        if (!auditedClose) {
            continue
        }

        await ctx.db.patch(fault._id, {
            blocked: false,
            resolvedAt: args.updatedAt,
            resolutionNote: `Provider reconciliation found audited canonical close order ${auditedClose.orderId} for inferred close ${fault.canonicalOrderId}`,
        })

        const entry = resolvedInferredCloseFaultsByStrategy.get(String(fault.strategyId)) ?? {
            strategyId: fault.strategyId,
            count: 0,
        }
        entry.count += 1
        resolvedInferredCloseFaultsByStrategy.set(String(fault.strategyId), entry)
    }

    for (const entry of resolvedMoneyFaultsByStrategy.values()) {
        await ctx.db.insert("alerts", {
            strategyId: entry.strategyId,
            app: args.app,
            severity: "info",
            message: `[execution-safety] Provider money-level reconciliation cleared ${entry.count} account fault(s) after a clean audit`,
            acknowledged: false,
            timestamp: args.updatedAt,
        })
    }

    for (const entry of resolvedInferredFillFaultsByStrategy.values()) {
        await ctx.db.insert("alerts", {
            strategyId: entry.strategyId,
            app: args.app,
            severity: "info",
            message: `[execution-safety] Provider money-level reconciliation cleared ${entry.count} inferred entry fill accounting fault(s) after a clean audit`,
            acknowledged: false,
            timestamp: args.updatedAt,
        })
    }

    for (const entry of resolvedInferredCloseFaultsByStrategy.values()) {
        await ctx.db.insert("alerts", {
            strategyId: entry.strategyId,
            app: args.app,
            severity: "info",
            message: `[execution-safety] Provider reconciliation cleared ${entry.count} inferred close accounting fault(s) after matching audited canonical close evidence`,
            acknowledged: false,
            timestamp: args.updatedAt,
        })
    }
}

function isOpenMoneyAuditMismatchFault(fault: Doc<"execution_safety_faults">): boolean {
    return fault.resolvedAt === undefined &&
        fault.category === "accounting_mismatch" &&
        fault.instrument === "account" &&
        fault.message.startsWith(MONEY_LEVEL_RECONCILIATION_FAULT_PREFIX)
}

function isOpenInferredEntryFillAccountingFault(fault: Doc<"execution_safety_faults">): boolean {
    return fault.resolvedAt === undefined &&
        fault.category === "accounting_mismatch" &&
        fault.message === INFERRED_ENTRY_FILL_ACCOUNTING_FAULT_MESSAGE
}

function isOpenInferredCloseFillAccountingFault(fault: Doc<"execution_safety_faults">): boolean {
    return fault.resolvedAt === undefined &&
        fault.category === "accounting_mismatch" &&
        fault.message === INFERRED_CLOSE_FILL_ACCOUNTING_FAULT_MESSAGE
}

async function resolveAuditedCloseOrderForInferredCloseFault(
    ctx: PortfolioMutationCtx,
    fault: Doc<"execution_safety_faults">
): Promise<Doc<"orders"> | undefined> {
    if (fault.app !== "okx-swap" || !fault.canonicalOrderId) {
        return undefined
    }

    const canonicalOrderId = fault.canonicalOrderId
    const inferredCloseOrder = await ctx.db
        .query("orders")
        .withIndex("by_order_id", (q) => q.eq("orderId", canonicalOrderId))
        .first()
    if (!inferredCloseOrder || !isInferredCloseFaultOrder(inferredCloseOrder, fault)) {
        return undefined
    }

    const closeSide = resolveClosedPositionSide(inferredCloseOrder)
    if (!closeSide) {
        return undefined
    }

    const quantity = resolveOrderFilledQuantity(inferredCloseOrder)
    const effectiveAt = resolveOrderEffectiveAt(inferredCloseOrder)
    if (quantity <= 0 || effectiveAt === undefined) {
        return undefined
    }

    const candidates = (
        await Promise.all([
            ctx.db
                .query("orders")
                .withIndex("by_strategy_status", (q) => q.eq("strategyId", fault.strategyId).eq("status", "filled"))
                .collect(),
            ctx.db
                .query("orders")
                .withIndex("by_strategy_status", (q) => q.eq("strategyId", fault.strategyId).eq("status", "partially_filled"))
                .collect(),
        ])
    ).flat()

    const matches = candidates.filter((candidate) =>
        candidate._id !== inferredCloseOrder._id &&
        isAuditedOkxCloseOrder(candidate) &&
        candidate.app === inferredCloseOrder.app &&
        candidate.accountId === inferredCloseOrder.accountId &&
        candidate.instrument === inferredCloseOrder.instrument &&
        resolveClosedPositionSide(candidate) === closeSide &&
        almostEqual(resolveOrderFilledQuantity(candidate), quantity) &&
        isWithinInferredCloseAuditWindow(resolveOrderEffectiveAt(candidate), effectiveAt)
    )

    return matches.length === 1
        ? matches[0]
        : undefined
}

function isInferredCloseFaultOrder(order: Doc<"orders">, fault: Doc<"execution_safety_faults">): boolean {
    return order.app === fault.app &&
        order.accountId === fault.accountId &&
        order.strategyId === fault.strategyId &&
        order.instrument === fault.instrument &&
        order.action === "close" &&
        (order.status === "filled" || order.status === "partially_filled") &&
        !hasNonZeroProviderAccountingMetadata(readOrderIntentMetadata(order.intent))
}

function isAuditedOkxCloseOrder(order: Doc<"orders">): boolean {
    const metadata = readOrderIntentMetadata(order.intent)
    return order.app === "okx-swap" &&
        order.action === "close" &&
        (order.status === "filled" || order.status === "partially_filled") &&
        metadata?.providerReconciledClose === true &&
        metadata.source === "okx_fills_history" &&
        hasNonZeroProviderAccountingMetadata(metadata)
}

function resolveClosedPositionSide(order: Doc<"orders">): "long" | "short" | undefined {
    const metadata = readOrderIntentMetadata(order.intent)
    if (metadata?.positionSide === "long" || metadata?.positionSide === "short") {
        return metadata.positionSide
    }

    const intent = readOrderIntentRecord(order.intent)
    if (intent?.side === "buy") {
        return "short"
    }
    if (intent?.side === "sell") {
        return "long"
    }

    return undefined
}

function resolveOrderFilledQuantity(order: Doc<"orders">): number {
    if (typeof order.filledQuantity === "number" && Number.isFinite(order.filledQuantity) && order.filledQuantity > 0) {
        return order.filledQuantity
    }

    return typeof order.quantity === "number" && Number.isFinite(order.quantity)
        ? order.quantity
        : 0
}

function resolveOrderEffectiveAt(order: Doc<"orders">): number | undefined {
    const metadata = readOrderIntentMetadata(order.intent)
    return readFiniteMetadataNumber(metadata?.providerAccountingOccurredAt) ??
        readFiniteMetadataNumber(order.updatedAt) ??
        readFiniteMetadataNumber(order.submittedAt)
}

function isWithinInferredCloseAuditWindow(candidateAt: number | undefined, inferredAt: number): boolean {
    return candidateAt !== undefined &&
        candidateAt >= inferredAt &&
        candidateAt - inferredAt <= INFERRED_CLOSE_AUDIT_MATCH_WINDOW_MS
}

async function recordMoneyAuditMismatchFaults(
    ctx: PortfolioMutationCtx,
    args: {
        app: Doc<"strategies">["app"]
        accountId: string
        venue: string
        message: string
        equityDelta: number
        attributedOrderPnl: number
        accountEventPnl: number
        openPnlDelta: number
        residual: number
        tolerance: number
        updatedAt: number
    }
): Promise<void> {
    const strategies = await ctx.db
        .query("strategies")
        .withIndex("by_app_account", (q) => q.eq("app", args.app).eq("accountId", args.accountId))
        .collect()
    if (strategies.length === 0) {
        return
    }

    const existingFaults = await ctx.db
        .query("execution_safety_faults")
        .withIndex("by_app_account_blocked", (q) =>
            q.eq("app", args.app).eq("accountId", args.accountId).eq("blocked", true)
        )
        .collect()
    const faultMessage = `Money-level reconciliation mismatch: ${args.message}`

    for (const strategy of strategies) {
        const duplicate = existingFaults.some((fault) =>
            fault.strategyId === strategy._id &&
            fault.category === "accounting_mismatch" &&
            fault.message === faultMessage
        )
        if (duplicate) {
            continue
        }

        await ctx.db.insert("execution_safety_faults", {
            strategyId: strategy._id,
            app: args.app,
            accountId: args.accountId,
            instrument: "account",
            category: "accounting_mismatch",
            message: faultMessage,
            providerPayload: JSON.stringify({
                app: args.app,
                accountId: args.accountId,
                venue: args.venue,
                equityDelta: args.equityDelta,
                attributedOrderPnl: args.attributedOrderPnl,
                accountEventPnl: args.accountEventPnl,
                openPnlDelta: args.openPnlDelta,
                residual: args.residual,
                tolerance: args.tolerance,
            }),
            blocked: true,
            occurredAt: args.updatedAt,
            resolvedAt: undefined,
        })
    }
}

async function resolveAttributedOrderPnlSince(
    ctx: PortfolioMutationCtx,
    args: {
        app: Doc<"strategies">["app"]
        accountId: string
        since: number
        until: number
    }
): Promise<number> {
    const strategies = await ctx.db
        .query("strategies")
        .withIndex("by_app_account", (q) => q.eq("app", args.app).eq("accountId", args.accountId))
        .collect()
    let sum = 0

    for (const strategy of strategies) {
        const orders = (
            await Promise.all([
                ctx.db
                    .query("orders")
                    .withIndex("by_strategy_status", (q) => q.eq("strategyId", strategy._id).eq("status", "filled"))
                    .collect(),
                ctx.db
                    .query("orders")
                    .withIndex("by_strategy_status", (q) => q.eq("strategyId", strategy._id).eq("status", "partially_filled"))
                    .collect(),
            ])
        ).flat()

        for (const order of orders) {
            const occurredAt = resolveOrderAccountingOccurredAt(order)
            if (occurredAt === undefined || occurredAt <= args.since || occurredAt > args.until) {
                continue
            }

            sum += resolveOrderRealizedPnl(order as never) ?? 0
        }
    }

    return sum
}

function resolveOrderAccountingOccurredAt(order: Pick<Doc<"orders">, "intent">): number | undefined {
    const metadata = readOrderIntentMetadata(order.intent)
    return readFiniteMetadataNumber(metadata?.providerAccountingOccurredAt)
}

function readOrderIntentMetadata(intent: unknown): Record<string, unknown> | undefined {
    if (!intent || typeof intent !== "object") {
        return undefined
    }

    const metadata = (intent as Record<string, unknown>).metadata
    return metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? metadata as Record<string, unknown>
        : undefined
}

function readFiniteMetadataNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value)
        ? value
        : undefined
}

function formatMoney(value: number): string {
    return Number.isFinite(value) ? value.toFixed(6) : String(value)
}

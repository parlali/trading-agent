import type { Doc, Id } from "../../_generated/dataModel"
import { getProviderInstrumentClaimAliases } from "../instrumentClaims"
import type {
    PortfolioMutationCtx,
    ReconciliationWriteStats,
} from "./portfolioTypes"
import { isInferredFillAccountingFaultMessage } from "./portfolioInferredFillFaults"

type ProviderPositionRow = Omit<Doc<"provider_positions">, "_id" | "_creationTime">
type ProviderPositionHistoryRow = Omit<Doc<"provider_position_history">, "_id" | "_creationTime">
type ProviderWorkingOrderRow = Omit<Doc<"provider_working_orders">, "_id" | "_creationTime">

const PROVIDER_POSITION_HISTORY_RETENTION_MS = 24 * 60 * 60 * 1000
const PROVIDER_POSITION_HISTORY_APPS = new Set<Doc<"strategies">["app"]>(["mt5", "okx-swap"])

const PROVIDER_POSITION_COMPARE_FIELDS = [
    "providerPositionId",
    "strategyId",
    "ownershipStatus",
    "expectedExternal",
    "instrument",
    "side",
    "quantity",
    "entryPrice",
    "currentPrice",
    "unrealizedPnl",
    "stopLoss",
    "takeProfit",
    "metadata",
] as const satisfies readonly (keyof ProviderPositionRow)[]

const PROVIDER_POSITION_PATCH_FIELDS = [
    ...PROVIDER_POSITION_COMPARE_FIELDS,
    "syncedAt",
] as const satisfies readonly (keyof ProviderPositionRow)[]

const PROVIDER_WORKING_ORDER_COMPARE_FIELDS = [
    "canonicalOrderId",
    "providerOrderId",
    "providerClientOrderId",
    "providerOrderAliases",
    "signedOrderFingerprint",
    "strategyId",
    "runId",
    "ownershipStatus",
    "expectedExternal",
    "venue",
    "instrument",
    "status",
    "action",
    "side",
    "quantity",
    "filledQuantity",
    "remainingQuantity",
    "limitPrice",
    "stopPrice",
    "avgFillPrice",
    "metadata",
    "submittedAt",
    "updatedAt",
    "cancelAt",
] as const satisfies readonly (keyof ProviderWorkingOrderRow)[]

const PROVIDER_WORKING_ORDER_PATCH_FIELDS = [
    ...PROVIDER_WORKING_ORDER_COMPARE_FIELDS,
    "syncedAt",
] as const satisfies readonly (keyof ProviderWorkingOrderRow)[]

export async function upsertProviderPositionRows(
    ctx: PortfolioMutationCtx,
    app: Doc<"strategies">["app"],
    accountId: string,
    rows: ProviderPositionRow[],
    updatedAt: number,
    existingRows?: Array<Doc<"provider_positions">>
): Promise<ReconciliationWriteStats> {
    const existing = existingRows ?? await ctx.db
        .query("provider_positions")
        .withIndex("by_app_account", (q) => q.eq("app", app).eq("accountId", accountId))
        .collect()

    const existingByKey = new Map(existing.map((row) => [row.positionKey, row]))
    const nextKeySet = new Set(rows.map((row) => row.positionKey))
    const stats = createWriteStats()
    const retainedHistoryByKey = PROVIDER_POSITION_HISTORY_APPS.has(app)
        ? await pruneProviderPositionHistory(ctx, app, accountId, nextKeySet, updatedAt)
        : new Map<string, Doc<"provider_position_history">>()

    for (const row of rows) {
        const current = existingByKey.get(row.positionKey)
        if (!current) {
            await ctx.db.insert("provider_positions", row)
            stats.inserted++
            continue
        }

        if (!hasFieldChange(current, row, PROVIDER_POSITION_COMPARE_FIELDS)) {
            await ctx.db.patch(current._id, { syncedAt: row.syncedAt })
            stats.unchanged++
            continue
        }

        await ctx.db.patch(current._id, pickFields(row, PROVIDER_POSITION_PATCH_FIELDS))
        stats.patched++
    }

    for (const row of existing) {
        if (nextKeySet.has(row.positionKey)) {
            continue
        }

        if (PROVIDER_POSITION_HISTORY_APPS.has(app)) {
            await upsertDisappearedProviderPositionHistory(ctx, {
                row,
                current: retainedHistoryByKey.get(row.positionKey),
                disappearedAt: updatedAt,
            })
        }

        await ctx.db.delete(row._id)
        stats.deleted++
    }

    return stats
}

async function pruneProviderPositionHistory(
    ctx: PortfolioMutationCtx,
    app: Doc<"strategies">["app"],
    accountId: string,
    livePositionKeys: Set<string>,
    updatedAt: number
): Promise<Map<string, Doc<"provider_position_history">>> {
    const history = await ctx.db
        .query("provider_position_history")
        .withIndex("by_app_account_retained_until", (q) =>
            q
                .eq("app", app)
                .eq("accountId", accountId)
                .gte("retainedUntil", updatedAt)
        )
        .collect()
    const retainedByKey = new Map<string, Doc<"provider_position_history">>()

    for (const row of history) {
        if (livePositionKeys.has(row.positionKey)) {
            await ctx.db.delete(row._id)
            continue
        }

        retainedByKey.set(row.positionKey, row)
    }

    return retainedByKey
}

async function upsertDisappearedProviderPositionHistory(
    ctx: PortfolioMutationCtx,
    args: {
        row: Doc<"provider_positions">
        current?: Doc<"provider_position_history">
        disappearedAt: number
    }
): Promise<void> {
    if (!shouldRetainProviderPositionHistory(args.row)) {
        return
    }

    const historyRow = buildProviderPositionHistoryRow(args.row, args.disappearedAt)
    if (args.current) {
        await ctx.db.patch(args.current._id, historyRow)
        return
    }

    await ctx.db.insert("provider_position_history", historyRow)
}

function shouldRetainProviderPositionHistory(row: Doc<"provider_positions">): boolean {
    return PROVIDER_POSITION_HISTORY_APPS.has(row.app) &&
        row.ownershipStatus === "owned" &&
        row.expectedExternal !== true &&
        row.strategyId !== undefined
}

function buildProviderPositionHistoryRow(
    row: Doc<"provider_positions">,
    disappearedAt: number
): ProviderPositionHistoryRow {
    return {
        app: row.app,
        accountId: row.accountId,
        positionKey: row.positionKey,
        providerPositionId: row.providerPositionId,
        strategyId: row.strategyId,
        ownershipStatus: row.ownershipStatus,
        expectedExternal: row.expectedExternal,
        instrument: row.instrument,
        side: row.side,
        quantity: row.quantity,
        entryPrice: row.entryPrice,
        currentPrice: row.currentPrice,
        unrealizedPnl: row.unrealizedPnl,
        stopLoss: row.stopLoss,
        takeProfit: row.takeProfit,
        metadata: row.metadata,
        lastSeenAt: row.syncedAt,
        disappearedAt,
        retainedUntil: disappearedAt + PROVIDER_POSITION_HISTORY_RETENTION_MS,
    }
}

export async function upsertProviderWorkingOrderRows(
    ctx: PortfolioMutationCtx,
    app: Doc<"strategies">["app"],
    accountId: string,
    rows: ProviderWorkingOrderRow[]
): Promise<ReconciliationWriteStats> {
    const existing = await ctx.db
        .query("provider_working_orders")
        .withIndex("by_app_account", (q) => q.eq("app", app).eq("accountId", accountId))
        .collect()

    const existingByKey = new Map(existing.map((row) => [row.orderId, row]))
    const nextKeySet = new Set(rows.map((row) => row.orderId))
    const stats = createWriteStats()

    for (const row of rows) {
        const current = existingByKey.get(row.orderId)
        if (!current) {
            await ctx.db.insert("provider_working_orders", row)
            stats.inserted++
            continue
        }

        if (!hasFieldChange(current, row, PROVIDER_WORKING_ORDER_COMPARE_FIELDS)) {
            await ctx.db.patch(current._id, { syncedAt: row.syncedAt })
            stats.unchanged++
            continue
        }

        await ctx.db.patch(current._id, pickFields(row, PROVIDER_WORKING_ORDER_PATCH_FIELDS))
        stats.patched++
    }

    for (const row of existing) {
        if (nextKeySet.has(row.orderId)) {
            continue
        }

        await ctx.db.delete(row._id)
        stats.deleted++
    }

    return stats
}

export async function resolveExecutionSafetyFaultsFromProviderTruth(
    ctx: PortfolioMutationCtx,
    args: {
        app: Doc<"strategies">["app"]
        accountId: string
        positions: Array<Pick<Doc<"provider_positions">, "instrument" | "ownershipStatus">>
        workingOrders: Array<Pick<
            Doc<"provider_working_orders">,
            "orderId" |
            "providerOrderId" |
            "providerClientOrderId" |
            "providerOrderAliases" |
            "signedOrderFingerprint" |
            "instrument" |
            "ownershipStatus"
        >>
        updatedAt: number
    }
): Promise<void> {
    const openFaults = await ctx.db
        .query("execution_safety_faults")
        .withIndex("by_app_account_blocked", (q) =>
            q.eq("app", args.app).eq("accountId", args.accountId).eq("blocked", true)
        )
        .collect()

    if (openFaults.length === 0) {
        return
    }

    const ownedPositionInstruments = args.positions
        .filter((position) => position.ownershipStatus === "owned")
        .map((position) => position.instrument)
    const ownedWorkingOrderInstruments = args.workingOrders
        .filter((order) => order.ownershipStatus === "owned")
        .map((order) => order.instrument)
    const resolvedByStrategy = new Map<string, { strategyId: Id<"strategies">; count: number }>()

    for (const fault of openFaults) {
        if (fault.resolvedAt !== undefined || fault.instrument === "*") {
            continue
        }

        const cancelledOrder = await resolveCancelledUnfilledOrderForInferredFillFault(ctx, fault)
        if (cancelledOrder) {
            await resolveFault(ctx, {
                fault,
                updatedAt: args.updatedAt,
                resolutionNote: `Provider reconciliation proved canonical order ${cancelledOrder.orderId} cancelled unfilled`,
                resolvedByStrategy,
            })
            continue
        }

        if (!isProviderTruthResolvableFault(fault.category)) {
            continue
        }

        const provenWorkingOrder = resolveExecutionFaultWorkingOrder(fault, args.workingOrders)
        if (provenWorkingOrder) {
            if (
                fault.category === "duplicate_exposure" &&
                hasResidualProviderExposureForDuplicateFault(args.app, fault.instrument, {
                    positions: args.positions,
                    workingOrders: args.workingOrders,
                    provenWorkingOrderId: provenWorkingOrder.orderId,
                })
            ) {
                continue
            }

            await resolveFault(ctx, {
                fault,
                updatedAt: args.updatedAt,
                resolutionNote: `Provider reconciliation proved live canonical working order ${provenWorkingOrder.orderId}`,
                resolvedByStrategy,
            })
            continue
        }

        const provenOrder = await resolveExecutionFaultOrderDoc(ctx, fault)
        if (provenOrder) {
            await resolveFault(ctx, {
                fault,
                updatedAt: args.updatedAt,
                resolutionNote: `Provider reconciliation proved terminal or recovered canonical order ${provenOrder.orderId}`,
                resolvedByStrategy,
            })
            continue
        }

        if (
            hasOwnedProviderExposureForFaultInstrument(args.app, fault.instrument, ownedPositionInstruments) ||
            hasOwnedProviderExposureForFaultInstrument(args.app, fault.instrument, ownedWorkingOrderInstruments)
        ) {
            continue
        }

        await resolveFault(ctx, {
            fault,
            updatedAt: args.updatedAt,
            resolutionNote: "Provider reconciliation confirmed flat exposure with no owned working orders on this instrument",
            resolvedByStrategy,
        })
    }

    for (const resolved of resolvedByStrategy.values()) {
        await ctx.db.insert("alerts", {
            strategyId: resolved.strategyId,
            app: args.app,
            severity: "info",
            message: `[execution-safety] Provider reconciliation cleared ${resolved.count} fault(s) after proving provider-safe state`,
            acknowledged: false,
            timestamp: args.updatedAt,
        })
    }
}

async function resolveFault(
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

    const existing = args.resolvedByStrategy.get(String(args.fault.strategyId)) ?? {
        strategyId: args.fault.strategyId,
        count: 0,
    }
    existing.count += 1
    args.resolvedByStrategy.set(String(args.fault.strategyId), existing)
}

export function resolveExecutionFaultWorkingOrder(
    fault: Doc<"execution_safety_faults">,
    workingOrders: Array<Pick<
        Doc<"provider_working_orders">,
        "orderId" |
        "providerOrderId" |
        "providerClientOrderId" |
        "providerOrderAliases" |
        "signedOrderFingerprint" |
        "instrument" |
        "ownershipStatus"
    >>
): Pick<Doc<"provider_working_orders">, "orderId"> | undefined {
    if (!isProviderTruthResolvableFault(fault.category) || fault.instrument === "*") {
        return undefined
    }

    const faultIdentifiers = new Set([
        fault.canonicalOrderId,
        fault.providerOrderId,
        fault.providerClientOrderId,
        fault.signedOrderFingerprint,
        ...(fault.providerOrderAliases ?? []),
    ].filter((value): value is string => Boolean(value)))
    if (faultIdentifiers.size === 0) {
        return undefined
    }

    const matches = workingOrders.filter((order) => {
        if (order.ownershipStatus !== "owned" || order.instrument !== fault.instrument) {
            return false
        }

        const orderIdentifiers = [
            order.orderId,
            order.providerOrderId,
            order.providerClientOrderId,
            order.signedOrderFingerprint,
            ...(order.providerOrderAliases ?? []),
        ].filter((value): value is string => Boolean(value))
        return orderIdentifiers.some((identifier) => faultIdentifiers.has(identifier))
    })

    return matches.length === 1 ? matches[0] : undefined
}

async function resolveExecutionFaultOrderDoc(
    ctx: PortfolioMutationCtx,
    fault: Doc<"execution_safety_faults">
): Promise<Doc<"orders"> | undefined> {
    if (fault.category !== "commit_unknown" || !fault.canonicalOrderId) {
        return undefined
    }

    const order = await ctx.db
        .query("orders")
        .withIndex("by_order_id", (q) => q.eq("orderId", fault.canonicalOrderId!))
        .first()
    if (!order) {
        return undefined
    }

    return order.commitOutcome !== "commit_unknown" ? order : undefined
}

async function resolveCancelledUnfilledOrderForInferredFillFault(
    ctx: PortfolioMutationCtx,
    fault: Doc<"execution_safety_faults">
): Promise<Doc<"orders"> | undefined> {
    if (
        fault.category !== "accounting_mismatch" ||
        !fault.canonicalOrderId ||
        !isInferredFillAccountingFaultMessage(fault.message)
    ) {
        return undefined
    }

    const order = await ctx.db
        .query("orders")
        .withIndex("by_order_id", (q) => q.eq("orderId", fault.canonicalOrderId!))
        .first()
    if (!order || order.status !== "cancelled" || order.filledQuantity !== 0) {
        return undefined
    }

    return order
}

function isProviderTruthResolvableFault(
    category: Doc<"execution_safety_faults">["category"]
): boolean {
    return category === "commit_unknown" || category === "duplicate_exposure"
}

function hasOwnedProviderExposureForFaultInstrument(
    app: Doc<"strategies">["app"],
    faultInstrument: string,
    ownedInstruments: string[]
): boolean {
    const faultAliases = new Set(getProviderInstrumentClaimAliases(app, faultInstrument))
    return ownedInstruments.some((instrument) =>
        getProviderInstrumentClaimAliases(app, instrument).some((alias) => faultAliases.has(alias))
    )
}

function hasResidualProviderExposureForDuplicateFault(
    app: Doc<"strategies">["app"],
    faultInstrument: string,
    exposure: {
        positions: Array<Pick<Doc<"provider_positions">, "instrument" | "ownershipStatus">>
        workingOrders: Array<Pick<Doc<"provider_working_orders">, "orderId" | "instrument" | "ownershipStatus">>
        provenWorkingOrderId: string
    }
): boolean {
    const ownedPositionInstruments = exposure.positions
        .filter((position) => position.ownershipStatus === "owned")
        .map((position) => position.instrument)
    if (hasOwnedProviderExposureForFaultInstrument(app, faultInstrument, ownedPositionInstruments)) {
        return true
    }

    const otherOwnedWorkingOrderInstruments = exposure.workingOrders
        .filter((order) =>
            order.ownershipStatus === "owned" &&
            order.orderId !== exposure.provenWorkingOrderId
        )
        .map((order) => order.instrument)
    return hasOwnedProviderExposureForFaultInstrument(app, faultInstrument, otherOwnedWorkingOrderInstruments)
}

function createWriteStats(): ReconciliationWriteStats {
    return {
        inserted: 0,
        patched: 0,
        deleted: 0,
        unchanged: 0,
    }
}

function hasFieldChange<TCurrent, TRow, K extends keyof TCurrent & keyof TRow>(
    current: TCurrent,
    row: TRow,
    fields: readonly K[]
): boolean {
    return fields.some((field) => !fieldValuesEqual(current[field] as unknown, row[field] as unknown))
}

function fieldValuesEqual(left: unknown, right: unknown): boolean {
    if (Array.isArray(left) && Array.isArray(right)) {
        return left.length === right.length && left.every((value, index) => value === right[index])
    }

    return left === right
}

function pickFields<TRow, K extends keyof TRow>(
    row: TRow,
    fields: readonly K[]
): Pick<TRow, K> {
    const picked = {} as Pick<TRow, K>

    for (const field of fields) {
        picked[field] = row[field]
    }

    return picked
}

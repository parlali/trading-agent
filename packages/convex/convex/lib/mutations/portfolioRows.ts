import type { Doc, Id } from "../../_generated/dataModel"
import type {
    PortfolioMutationCtx,
    ReconciliationWriteStats,
} from "./portfolioTypes"

type ProviderPositionRow = Omit<Doc<"provider_positions">, "_id" | "_creationTime">
type ProviderWorkingOrderRow = Omit<Doc<"provider_working_orders">, "_id" | "_creationTime">

const PROVIDER_POSITION_PATCH_FIELDS = [
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
    "syncedAt",
] as const satisfies readonly (keyof ProviderPositionRow)[]

const PROVIDER_WORKING_ORDER_PATCH_FIELDS = [
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
    "syncedAt",
] as const satisfies readonly (keyof ProviderWorkingOrderRow)[]

export async function upsertProviderPositionRows(
    ctx: PortfolioMutationCtx,
    app: Doc<"strategies">["app"],
    rows: ProviderPositionRow[]
): Promise<ReconciliationWriteStats> {
    const existing = await ctx.db
        .query("provider_positions")
        .withIndex("by_app", (q) => q.eq("app", app))
        .collect()

    const existingByKey = new Map(existing.map((row) => [row.positionKey, row]))
    const nextKeySet = new Set(rows.map((row) => row.positionKey))
    const stats = createWriteStats()

    for (const row of rows) {
        const current = existingByKey.get(row.positionKey)
        if (!current) {
            await ctx.db.insert("provider_positions", row)
            stats.inserted++
            continue
        }

        const changed = hasFieldChange(current, row, PROVIDER_POSITION_PATCH_FIELDS)

        if (!changed) {
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

        await ctx.db.delete(row._id)
        stats.deleted++
    }

    return stats
}

export async function upsertProviderWorkingOrderRows(
    ctx: PortfolioMutationCtx,
    app: Doc<"strategies">["app"],
    rows: ProviderWorkingOrderRow[]
): Promise<ReconciliationWriteStats> {
    const existing = await ctx.db
        .query("provider_working_orders")
        .withIndex("by_app", (q) => q.eq("app", app))
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

        const changed = hasFieldChange(current, row, PROVIDER_WORKING_ORDER_PATCH_FIELDS)

        if (!changed) {
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
        positions: Array<Pick<Doc<"provider_positions">, "instrument" | "ownershipStatus">>
        workingOrders: Array<Pick<Doc<"provider_working_orders">, "instrument" | "ownershipStatus">>
        updatedAt: number
    }
): Promise<void> {
    const openFaults = await ctx.db
        .query("execution_safety_faults")
        .withIndex("by_app_blocked", (q) => q.eq("app", args.app).eq("blocked", true))
        .collect()

    if (openFaults.length === 0) {
        return
    }

    const ownedPositionInstruments = new Set(
        args.positions
            .filter((position) => position.ownershipStatus === "owned")
            .map((position) => position.instrument)
    )
    const ownedWorkingOrderInstruments = new Set(
        args.workingOrders
            .filter((order) => order.ownershipStatus === "owned")
            .map((order) => order.instrument)
    )
    const resolvedByStrategy = new Map<string, { strategyId: Id<"strategies">; count: number }>()

    for (const fault of openFaults) {
        if (fault.resolvedAt !== undefined || fault.instrument === "*") {
            continue
        }

        if (
            ownedPositionInstruments.has(fault.instrument) ||
            ownedWorkingOrderInstruments.has(fault.instrument)
        ) {
            continue
        }

        await ctx.db.patch(fault._id, {
            blocked: false,
            resolvedAt: args.updatedAt,
            resolutionNote: "Provider reconciliation confirmed flat exposure with no owned working orders on this instrument",
        })

        const existing = resolvedByStrategy.get(String(fault.strategyId)) ?? {
            strategyId: fault.strategyId,
            count: 0,
        }
        existing.count += 1
        resolvedByStrategy.set(String(fault.strategyId), existing)
    }

    for (const resolved of resolvedByStrategy.values()) {
        await ctx.db.insert("alerts", {
            strategyId: resolved.strategyId,
            app: args.app,
            severity: "info",
            message: `[execution-safety] Provider reconciliation cleared ${resolved.count} fault(s) after confirming flat exposure`,
            acknowledged: false,
            timestamp: args.updatedAt,
        })
    }
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
    return fields.some((field) => (current[field] as unknown) !== (row[field] as unknown))
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

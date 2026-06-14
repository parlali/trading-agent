import { query } from "../../_generated/server"
import { v } from "convex/values"
import {
    VENUE_APPS,
    type EventType,
    type OrderAction,
    type OrderStatus,
    type OrderSide,
} from "@valiq-trading/core"
import type { Doc } from "../../_generated/dataModel"
import { requireUser, requireUserOrServiceToken } from "../authGuards"
import { venueAppV } from "../validators"
import { isDryRunLedgerMetadata } from "../dryRunLedger"
import { parseJson } from "../mutations/portfolioUtils"

const PORTFOLIO_STALE_AFTER_MS = 10 * 60 * 1000

const equityTimeRangeV = v.union(
    v.literal("24h"),
    v.literal("7d"),
    v.literal("30d"),
    v.literal("90d"),
    v.literal("all")
)

export const getPortfolioFreshness = query({
    args: {
        serviceToken: v.optional(v.string()),
        app: v.optional(venueAppV),
        accountId: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        await requireUserOrServiceToken(ctx, args.serviceToken)

        if (args.app && args.accountId) {
            const row = await ctx.db
                .query("provider_sync_state")
                .withIndex("by_app_account", (q) => q.eq("app", args.app!).eq("accountId", args.accountId!))
                .first()
            return [buildFreshnessDto(args.app, row)]
        }

        const rows = args.app
            ? await ctx.db
                .query("provider_sync_state")
                .withIndex("by_app", (q) => q.eq("app", args.app!))
                .collect()
            : await ctx.db.query("provider_sync_state").collect()

        return rows.map((row) => buildFreshnessDto(row.app, row))
    },
})

export const getPortfolioAccountSnapshots = query({
    args: {
        serviceToken: v.optional(v.string()),
        app: v.optional(venueAppV),
        accountId: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        await requireUserOrServiceToken(ctx, args.serviceToken)

        const rows = args.app
            ? await ctx.db
                .query("account_snapshots")
                .withIndex(
                    args.accountId ? "by_app_account" : "by_app",
                    (q) => args.accountId
                        ? q.eq("app", args.app!).eq("accountId", args.accountId!)
                        : q.eq("app", args.app!)
                )
                .collect()
            : await ctx.db.query("account_snapshots").collect()

        const latestByAccount = new Map<string, typeof rows[number]>()
        for (const row of rows) {
            const key = `${row.app}:${row.accountId ?? "unassigned"}`
            const existing = latestByAccount.get(key)
            if (!existing || row.timestamp > existing.timestamp) {
                latestByAccount.set(key, row)
            }
        }

        return Array.from(latestByAccount.values())
            .sort((left, right) =>
                left.app.localeCompare(right.app) ||
                (left.accountId ?? "unassigned").localeCompare(right.accountId ?? "unassigned")
            )
            .map((row) => ({
                app: row.app,
                accountId: row.accountId ?? "unassigned",
                venue: row.venue,
                balance: row.balance,
                equity: row.equity ?? (row.balance + row.openPnl),
                buyingPower: row.buyingPower,
                marginUsed: row.marginUsed,
                marginAvailable: row.marginAvailable,
                openPnl: row.openPnl,
                dayPnl: row.dayPnl,
                timestamp: row.timestamp,
            }))
    },
})

export const getPortfolioPositions = query({
    args: {
        serviceToken: v.optional(v.string()),
        app: v.optional(venueAppV),
        accountId: v.optional(v.string()),
        strategyId: v.optional(v.id("strategies")),
    },
    handler: async (ctx, args) => {
        await requireUserOrServiceToken(ctx, args.serviceToken)

        const [rows, strategies, latestPositionSyncs] = await Promise.all([
            args.app
                ? ctx.db
                    .query("provider_positions")
                    .withIndex(
                        args.accountId ? "by_app_account" : "by_app",
                        (q) => args.accountId
                            ? q.eq("app", args.app!).eq("accountId", args.accountId!)
                            : q.eq("app", args.app!)
                    )
                    .collect()
                : ctx.db.query("provider_positions").collect(),
            ctx.db.query("strategies").collect(),
            ctx.db.query("position_syncs").collect(),
        ])

        const strategyMap = new Map(strategies.map((strategy) => [String(strategy._id), strategy]))
        const dryRunStrategies = strategies.filter((strategy) => {
            if (args.app && strategy.app !== args.app) {
                return false
            }
            if (args.strategyId && strategy._id !== args.strategyId) {
                return false
            }
            return Boolean((strategy.policy as Record<string, unknown>).dryRun)
        })
        const latestDryRunSyncByStrategy = new Map<string, Doc<"position_syncs">>()
        for (const sync of latestPositionSyncs) {
            const strategy = strategyMap.get(String(sync.strategyId))
            if (!strategy || !dryRunStrategies.some((candidate) => candidate._id === sync.strategyId)) {
                continue
            }

            const existing = latestDryRunSyncByStrategy.get(String(sync.strategyId))
            if (!existing || sync.syncedAt > existing.syncedAt) {
                latestDryRunSyncByStrategy.set(String(sync.strategyId), sync)
            }
        }
        const dryRunPositionRows = (
            await Promise.all(
                Array.from(latestDryRunSyncByStrategy.values()).map(async (sync) => {
                    if (sync.positionCount === 0) {
                        return []
                    }

                    return await ctx.db
                        .query("positions")
                        .withIndex("by_strategy_synced_at", (q) =>
                            q.eq("strategyId", sync.strategyId).eq("syncedAt", sync.syncedAt)
                        )
                        .collect()
                })
            )
        ).flat()

        return [
            ...rows
                .filter((row) => {
                    if (args.strategyId && row.strategyId !== args.strategyId) {
                        return false
                    }
                    return true
                })
                .sort((left, right) => left.instrument.localeCompare(right.instrument))
                .map((row) => ({
                    app: row.app,
                    accountId: row.accountId,
                    positionKey: row.positionKey,
                    providerPositionId: row.providerPositionId,
                    strategyId: row.strategyId ? String(row.strategyId) : undefined,
                    strategyName: row.strategyId ? strategyMap.get(String(row.strategyId))?.name : undefined,
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
                    syncedAt: row.syncedAt,
                    metadata: parseJson(row.metadata),
                })),
            ...dryRunPositionRows
                .filter((row) => !isDryRunLedgerMetadata(row.metadata))
                .map((row) => {
                    const strategy = strategyMap.get(String(row.strategyId))
                    return {
                        app: row.app,
                        accountId: row.accountId,
                        positionKey: row.positionKey,
                        providerPositionId: row.providerPositionId,
                        strategyId: String(row.strategyId),
                        strategyName: strategy?.name,
                        ownershipStatus: "owned" as const,
                        instrument: row.instrument,
                        side: row.side,
                        quantity: row.quantity,
                        entryPrice: row.entryPrice,
                        currentPrice: row.currentPrice,
                        unrealizedPnl: row.unrealizedPnl,
                        stopLoss: row.stopLoss,
                        takeProfit: row.takeProfit,
                        syncedAt: row.syncedAt,
                        metadata: {
                            ...(parseJson<Record<string, unknown>>(row.metadata) ?? {}),
                            dryRun: true,
                            source: "strategy_virtual_position",
                        },
                    }
                }),
        ].sort((left, right) => left.instrument.localeCompare(right.instrument))
    },
})

export const getPortfolioPendingOrders = query({
    args: {
        serviceToken: v.optional(v.string()),
        app: v.optional(venueAppV),
        accountId: v.optional(v.string()),
        strategyId: v.optional(v.id("strategies")),
    },
    handler: async (ctx, args) => {
        await requireUserOrServiceToken(ctx, args.serviceToken)

        const [rows, strategies] = await Promise.all([
            args.app
                ? ctx.db
                    .query("provider_working_orders")
                    .withIndex(
                        args.accountId ? "by_app_account" : "by_app",
                        (q) => args.accountId
                            ? q.eq("app", args.app!).eq("accountId", args.accountId!)
                            : q.eq("app", args.app!)
                    )
                    .collect()
                : ctx.db.query("provider_working_orders").collect(),
            ctx.db.query("strategies").collect(),
        ])

        const strategyMap = new Map(strategies.map((strategy) => [String(strategy._id), strategy]))

        return rows
            .filter((row) => {
                if (args.strategyId && row.strategyId !== args.strategyId) {
                    return false
                }
                return true
            })
            .sort((left, right) => right.updatedAt - left.updatedAt)
            .map((row) => ({
                app: row.app,
                accountId: row.accountId,
                strategyId: row.strategyId ? String(row.strategyId) : undefined,
                strategyName: row.strategyId ? strategyMap.get(String(row.strategyId))?.name : undefined,
                ownershipStatus: row.ownershipStatus,
                expectedExternal: row.expectedExternal,
                orderId: row.orderId,
                canonicalOrderId: row.canonicalOrderId,
                providerOrderId: row.providerOrderId,
                providerClientOrderId: row.providerClientOrderId,
                providerOrderAliases: row.providerOrderAliases ?? [],
                signedOrderFingerprint: row.signedOrderFingerprint,
                instrument: row.instrument,
                venue: row.venue,
                status: row.status,
                action: row.action,
                quantity: row.quantity,
                filledQuantity: row.filledQuantity,
                remainingQuantity: row.remainingQuantity,
                side: row.side,
                limitPrice: row.limitPrice,
                stopPrice: row.stopPrice,
                avgFillPrice: row.avgFillPrice,
                submittedAt: row.submittedAt,
                updatedAt: row.updatedAt,
                cancelAt: row.cancelAt,
                metadata: parseJson(row.metadata),
            }))
    },
})

export const getPortfolioTradeHistory = query({
    args: {
        app: v.optional(venueAppV),
        strategyId: v.optional(v.id("strategies")),
        limit: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
        await requireUser(ctx)

        const limit = Math.max(1, Math.min(args.limit ?? 100, 500))
        const strategies = await ctx.db.query("strategies").collect()
        const strategyMap = new Map(strategies.map((strategy) => [String(strategy._id), strategy]))

        const rawEvents = args.strategyId
            ? await ctx.db
                .query("trade_events")
                .withIndex("by_strategy", (q) => q.eq("strategyId", args.strategyId!))
                .collect()
            : args.app
                ? await ctx.db
                    .query("trade_events")
                    .withIndex("by_app_timestamp", (q) => q.eq("app", args.app!))
                    .order("desc")
                    .take(limit * 10)
                : await ctx.db
                    .query("trade_events")
                    .order("desc")
                    .take(limit * 10)

        const events = rawEvents
            .filter((event) => {
                const strategy = strategyMap.get(String(event.strategyId))
                if (!strategy) {
                    return false
                }
                if (args.app && strategy.app !== args.app) {
                    return false
                }
                if (args.strategyId && event.strategyId !== args.strategyId) {
                    return false
                }
                return true
            })
            .sort((left, right) => right.timestamp - left.timestamp)
            .slice(0, limit)

        const orderIds = Array.from(new Set(events.map(extractOrderId).filter(Boolean) as string[]))
        const orders = await Promise.all(
            orderIds.map((orderId) =>
                ctx.db
                    .query("orders")
                    .withIndex("by_order_id", (q) => q.eq("orderId", orderId))
                    .first()
            )
        )
        const orderMap = new Map(
            orders
                .filter((order): order is NonNullable<typeof order> => Boolean(order))
                .map((order) => [order.orderId, order])
        )

        return events.map((event) => {
            const strategy = strategyMap.get(String(event.strategyId))
            const payload = parseJson<Record<string, unknown>>(event.payload)
            const orderId = extractOrderId(event)
            const order = orderId ? orderMap.get(orderId) : undefined

            return {
                eventId: String(event._id),
                timestamp: event.timestamp,
                app: (strategy?.app ?? event.app)!,
                accountId: event.accountId ?? order?.accountId ?? strategy?.accountId ?? "unassigned",
                strategyId: String(event.strategyId),
                strategyName: strategy?.name ?? "Unknown strategy",
                runId: String(event.runId),
                orderId,
                instrument: extractInstrument(payload, order),
                eventType: event.eventType,
                action: extractAction(payload, order),
                status: extractStatus(payload, order),
                side: extractSide(payload, order),
                quantity: extractQuantity(payload, order),
                filledQuantity: extractFilledQuantity(payload, order),
                price: extractPrice(payload, order),
                accountingStatus: extractAccountingStatus(payload, order),
                accountingSource: extractAccountingSource(payload, order),
                accountingMissingReason: extractAccountingMissingReason(payload, order),
                summary: summarizeTradeEvent(event, payload, order, strategy?.name ?? "Unknown strategy"),
            }
        })
    },
})

export const getPortfolioEquitySeries = query({
    args: {
        app: v.optional(venueAppV),
        timeRange: equityTimeRangeV,
    },
    handler: async (ctx, args) => {
        await requireUser(ctx)

        const end = Date.now()
        const rangeStart = resolveRangeStart(args.timeRange, end)
        const apps = args.app ? [args.app] : VENUE_APPS
        const snapshotWindows = await Promise.all(
            apps.map(async (app) => {
                const inRangeRows = await ctx.db
                    .query("account_snapshots")
                    .withIndex("by_app_timestamp", (q) => q.eq("app", app).gte("timestamp", rangeStart))
                    .order("asc")
                    .collect()

                if (rangeStart <= 0) {
                    return { baselines: [] as Doc<"account_snapshots">[], inRangeRows }
                }

                const accounts = await ctx.db
                    .query("accounts")
                    .withIndex("by_app", (q) => q.eq("app", app))
                    .collect()
                const accountBuckets: Array<string | undefined> = [
                    ...accounts.map((account) => account.accountId),
                    undefined,
                ]
                const baselineRows = await Promise.all(
                    accountBuckets.map((accountId) =>
                        ctx.db
                            .query("account_snapshots")
                            .withIndex("by_app_timestamp", (q) => q.eq("app", app).lt("timestamp", rangeStart))
                            .order("desc")
                            .filter((q) => q.eq(q.field("accountId"), accountId))
                            .first()
                    )
                )

                return {
                    baselines: baselineRows.filter(
                        (row): row is Doc<"account_snapshots"> => row !== null
                    ),
                    inRangeRows,
                }
            })
        )

        const latestByAccountBucket = new Map<string, EquityBucket>()
        let latestTimestamp = 0

        const recordSnapshot = (snapshot: Doc<"account_snapshots">): void => {
            latestByAccountBucket.set(createEquityBucketKey(snapshot), {
                app: snapshot.app,
                equity: resolveSnapshotEquity(snapshot),
            })
            latestTimestamp = Math.max(latestTimestamp, snapshot.timestamp)
        }

        for (const window of snapshotWindows) {
            for (const baseline of window.baselines) {
                recordSnapshot(baseline)
            }
        }

        const snapshots = snapshotWindows
            .flatMap((window) => window.inRangeRows)
            .sort((left, right) => left.timestamp - right.timestamp)
        const series = snapshots.map((snapshot) => {
            recordSnapshot(snapshot)

            return {
                timestamp: snapshot.timestamp,
                ...aggregateEquityBuckets(latestByAccountBucket),
            }
        })

        return {
            timeRange: args.timeRange,
            app: args.app,
            start: rangeStart,
            end,
            latest: series[series.length - 1] ?? (
                latestByAccountBucket.size > 0
                    ? {
                        timestamp: latestTimestamp || end,
                        ...aggregateEquityBuckets(latestByAccountBucket),
                    }
                    : null
            ),
            series,
        }
    },
})

type EquityBucket = {
    app: Doc<"account_snapshots">["app"]
    equity: number
}

function createEquityBucketKey(snapshot: Doc<"account_snapshots">): string {
    return `${snapshot.app}:${snapshot.accountId ?? "legacy"}`
}

function aggregateEquityBuckets(
    latestByAccountBucket: Map<string, EquityBucket>
): { total: number; providers: Record<string, number> } {
    const providers: Record<string, number> = {}
    let total = 0

    for (const bucket of latestByAccountBucket.values()) {
        providers[bucket.app] = (providers[bucket.app] ?? 0) + bucket.equity
        total += bucket.equity
    }

    return { total, providers }
}

function buildFreshnessDto(
    app: typeof VENUE_APPS[number],
    row: Doc<"provider_sync_state"> | null
) {
    const stale = isStale(row?.lastVerifiedAt)
    const providerStatus = stale
        ? "stale"
        : row?.providerStatus ?? "stale"

    return {
        app,
        accountId: row?.accountId ?? "unassigned",
        accountScope: "account" as const,
        lastSyncedAt: row?.lastSyncedAt,
        lastVerifiedAt: row?.lastVerifiedAt,
        providerStatus,
        stale,
        driftDetected: row?.driftDetected ?? false,
        lastError: row?.lastError,
        lastDriftSummary: row?.lastDriftSummary,
        positionCount: row?.positionCount ?? 0,
        pendingOrderCount: row?.pendingOrderCount ?? 0,
    }
}

function isStale(lastVerifiedAt: number | undefined): boolean {
    if (!lastVerifiedAt) {
        return true
    }

    return Date.now() - lastVerifiedAt > PORTFOLIO_STALE_AFTER_MS
}

function extractOrderId(event: Doc<"trade_events">): string | undefined {
    const payload = parseJson<Record<string, unknown>>(event.payload)
    if (!payload) {
        return undefined
    }

    const resultOrderId = readString(payload.result, "orderId")
    if (resultOrderId) {
        return resultOrderId
    }

    const metadataOrderId = readString(payload.intent, "metadata", "orderId")
    if (metadataOrderId) {
        return metadataOrderId
    }

    return readString(payload, "orderId")
}

function extractInstrument(
    payload: Record<string, unknown> | undefined,
    order: Doc<"orders"> | undefined
): string | undefined {
    return readString(payload?.intent, "instrument")
        ?? readString(payload, "instrument")
        ?? order?.instrument
}

function extractAction(
    payload: Record<string, unknown> | undefined,
    order: Doc<"orders"> | undefined
): OrderAction | undefined {
    const action = readString(payload?.intent, "metadata", "action") ?? order?.action
    if (action === "entry" || action === "adjustment" || action === "close" || action === "modify" || action === "cancel") {
        return action
    }
    return undefined
}

function extractStatus(
    payload: Record<string, unknown> | undefined,
    order: Doc<"orders"> | undefined
): OrderStatus | undefined {
    const status = readString(payload?.result, "status")
        ?? readString(payload, "status")
        ?? order?.status

    if (
        status === "pending" ||
        status === "partially_filled" ||
        status === "filled" ||
        status === "rejected" ||
        status === "cancelled" ||
        status === "expired" ||
        status === "timed_out"
    ) {
        return status
    }

    return undefined
}

function extractSide(
    payload: Record<string, unknown> | undefined,
    order: Doc<"orders"> | undefined
): OrderSide | undefined {
    const side = readString(payload?.intent, "side")
        ?? order?.intent?.side

    if (side === "buy" || side === "sell") {
        return side
    }

    return undefined
}

function extractQuantity(
    payload: Record<string, unknown> | undefined,
    order: Doc<"orders"> | undefined
): number | undefined {
    return readNumber(payload?.intent, "quantity")
        ?? readNumber(payload, "quantity")
        ?? order?.quantity
}

function extractFilledQuantity(
    payload: Record<string, unknown> | undefined,
    order: Doc<"orders"> | undefined
): number | undefined {
    return readNumber(payload?.result, "filledQuantity")
        ?? readNumber(payload, "filledQuantity")
        ?? order?.filledQuantity
}

function extractPrice(
    payload: Record<string, unknown> | undefined,
    order: Doc<"orders"> | undefined
): number | undefined {
    return readNumber(payload?.result, "fillPrice")
        ?? readNumber(payload?.intent, "limitPrice")
        ?? order?.avgFillPrice
        ?? order?.intent?.limitPrice
}

function extractAccountingStatus(
    payload: Record<string, unknown> | undefined,
    order: Doc<"orders"> | undefined
): "missing" | "estimated" | "provider" | undefined {
    const metadata = extractAccountingMetadata(payload, order)
    if (!metadata) {
        return undefined
    }

    if (metadata.providerAccountingMissing === true || metadata.providerAccountingBackfillMissing === true) {
        return "missing"
    }

    if (metadata.providerFeeEstimated === true) {
        return "estimated"
    }

    if (typeof metadata.providerAccountingSource === "string") {
        return "provider"
    }

    return undefined
}

function extractAccountingSource(
    payload: Record<string, unknown> | undefined,
    order: Doc<"orders"> | undefined
): string | undefined {
    const source = extractAccountingMetadata(payload, order)?.providerAccountingSource
    return typeof source === "string" ? source : undefined
}

function extractAccountingMissingReason(
    payload: Record<string, unknown> | undefined,
    order: Doc<"orders"> | undefined
): string | undefined {
    const metadata = extractAccountingMetadata(payload, order)
    const reason = metadata?.providerAccountingMissingReason ?? metadata?.providerAccountingBackfillMissingReason
    return typeof reason === "string" ? reason : undefined
}

function extractAccountingMetadata(
    payload: Record<string, unknown> | undefined,
    order: Doc<"orders"> | undefined
): Record<string, unknown> | undefined {
    return {
        ...readMetadataRecord(readRecord(readRecord(payload?.result)?.intentUpdates)?.metadata),
        ...readMetadataRecord(readRecord(payload?.intent)?.metadata),
        ...readMetadataRecord(order?.intent?.metadata),
    }
}

function readMetadataRecord(value: unknown): Record<string, unknown> | undefined {
    return readRecord(value)
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" ? value as Record<string, unknown> : undefined
}

function summarizeTradeEvent(
    event: Doc<"trade_events">,
    payload: Record<string, unknown> | undefined,
    order: Doc<"orders"> | undefined,
    strategyName: string
): string {
    const instrument = extractInstrument(payload, order)
    const status = extractStatus(payload, order)
    const quantity = extractQuantity(payload, order)
    const side = extractSide(payload, order)

    switch (event.eventType as EventType) {
        case "intent":
            return `${strategyName} proposed ${side ?? "order"} ${quantity ?? ""} ${instrument ?? ""}`.trim()
        case "validation":
            return `${strategyName} validation passed for ${instrument ?? "order"}`
        case "submission":
            return `${strategyName} submitted ${instrument ?? "order"}${status ? ` (${status})` : ""}`
        case "fill_update":
            return `${strategyName} received fill update for ${instrument ?? "order"}`
        case "filled":
            return `${strategyName} filled ${instrument ?? "order"}`
        case "rejected":
            return `${strategyName} rejected ${instrument ?? "order"}`
        case "cancelled":
            return `${strategyName} cancelled ${instrument ?? "order"}`
        default:
            return `${strategyName} recorded ${event.eventType}`
    }
}

function resolveRangeStart(
    timeRange: "24h" | "7d" | "30d" | "90d" | "all",
    end: number
): number {
    const durationMsByRange = {
        "24h": 24 * 60 * 60 * 1000,
        "7d": 7 * 24 * 60 * 60 * 1000,
        "30d": 30 * 24 * 60 * 60 * 1000,
        "90d": 90 * 24 * 60 * 60 * 1000,
        "all": Infinity,
    } as const

    return timeRange === "all" ? 0 : end - durationMsByRange[timeRange]
}

function resolveSnapshotEquity(snapshot: Doc<"account_snapshots">): number {
    return snapshot.equity ?? (snapshot.balance + snapshot.openPnl)
}

function readString(value: unknown, ...path: string[]): string | undefined {
    const resolved = readValue(value, ...path)
    return typeof resolved === "string" && resolved.trim() ? resolved : undefined
}

function readNumber(value: unknown, ...path: string[]): number | undefined {
    const resolved = readValue(value, ...path)
    return typeof resolved === "number" && Number.isFinite(resolved) ? resolved : undefined
}

function readValue(value: unknown, ...path: string[]): unknown {
    let current = value

    for (const segment of path) {
        if (!current || typeof current !== "object" || !(segment in current)) {
            return undefined
        }
        current = (current as Record<string, unknown>)[segment]
    }

    return current
}

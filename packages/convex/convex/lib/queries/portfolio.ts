import { query } from "../../_generated/server"
import { v } from "convex/values"
import { VENUE_APPS, type EventType, type OrderAction, type OrderStatus, type OrderSide } from "@valiq-trading/core"
import type { Doc } from "../../_generated/dataModel"
import { requireUser, requireUserOrServiceToken } from "../authGuards"
import { venueAppV } from "../validators"

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
    },
    handler: async (ctx, args) => {
        await requireUserOrServiceToken(ctx, args.serviceToken)

        const apps = args.app ? [args.app] : VENUE_APPS
        const rows = await Promise.all(
            apps.map((app) =>
                ctx.db
                    .query("provider_sync_state")
                    .withIndex("by_app", (q) => q.eq("app", app))
                    .first()
            )
        )

        return rows.map((row, index) => buildFreshnessDto(apps[index]!, row))
    },
})

export const getPortfolioPositions = query({
    args: {
        serviceToken: v.optional(v.string()),
        app: v.optional(venueAppV),
        strategyId: v.optional(v.id("strategies")),
    },
    handler: async (ctx, args) => {
        await requireUserOrServiceToken(ctx, args.serviceToken)

        const [rows, strategies] = await Promise.all([
            args.app
                ? ctx.db
                    .query("provider_positions")
                    .withIndex("by_app", (q) => q.eq("app", args.app!))
                    .collect()
                : ctx.db.query("provider_positions").collect(),
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
            .sort((left, right) => left.instrument.localeCompare(right.instrument))
            .map((row) => ({
                app: row.app,
                strategyId: row.strategyId ? String(row.strategyId) : undefined,
                strategyName: row.strategyId ? strategyMap.get(String(row.strategyId))?.name : undefined,
                ownershipStatus: row.ownershipStatus,
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
            }))
    },
})

export const getPortfolioPendingOrders = query({
    args: {
        serviceToken: v.optional(v.string()),
        app: v.optional(venueAppV),
        strategyId: v.optional(v.id("strategies")),
    },
    handler: async (ctx, args) => {
        await requireUserOrServiceToken(ctx, args.serviceToken)

        const [rows, strategies] = await Promise.all([
            args.app
                ? ctx.db
                    .query("provider_working_orders")
                    .withIndex("by_app", (q) => q.eq("app", args.app!))
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
                strategyId: row.strategyId ? String(row.strategyId) : undefined,
                strategyName: row.strategyId ? strategyMap.get(String(row.strategyId))?.name : undefined,
                ownershipStatus: row.ownershipStatus,
                orderId: row.orderId,
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
            apps.map((app) =>
                Promise.all([
                    ctx.db
                        .query("account_snapshots")
                        .withIndex("by_app_timestamp", (q) => q.eq("app", app).lt("timestamp", rangeStart))
                        .order("desc")
                        .take(1),
                    ctx.db
                        .query("account_snapshots")
                        .withIndex("by_app_timestamp", (q) => q.eq("app", app).gte("timestamp", rangeStart))
                        .order("asc")
                        .collect(),
                ])
            )
        )

        const latestByApp = new Map<Doc<"account_snapshots">["app"], number>()
        let latestTimestamp = 0

        for (const [baselineRows] of snapshotWindows) {
            const baseline = baselineRows[0]
            if (!baseline) {
                continue
            }

            latestByApp.set(baseline.app, resolveSnapshotEquity(baseline))
            latestTimestamp = Math.max(latestTimestamp, baseline.timestamp)
        }

        const snapshots = snapshotWindows
            .flatMap(([, inRangeRows]) => inRangeRows)
            .sort((left, right) => left.timestamp - right.timestamp)
        const series = snapshots.map((snapshot) => {
            latestByApp.set(snapshot.app, resolveSnapshotEquity(snapshot))
            latestTimestamp = Math.max(latestTimestamp, snapshot.timestamp)
            const providers = Object.fromEntries(latestByApp.entries())
            const total = Array.from(latestByApp.values()).reduce((sum, value) => sum + value, 0)

            return {
                timestamp: snapshot.timestamp,
                total,
                providers,
            }
        })

        return {
            timeRange: args.timeRange,
            app: args.app,
            start: rangeStart,
            end,
            latest: series[series.length - 1] ?? (
                latestByApp.size > 0
                    ? {
                        timestamp: latestTimestamp || end,
                        total: Array.from(latestByApp.values()).reduce((sum, value) => sum + value, 0),
                        providers: Object.fromEntries(latestByApp.entries()),
                    }
                    : null
            ),
            series,
        }
    },
})

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
        accountScope: "single-account-per-venue" as const,
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

function parseJson<T>(value: string | undefined): T | undefined {
    if (!value) {
        return undefined
    }

    try {
        return JSON.parse(value) as T
    } catch {
        return undefined
    }
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

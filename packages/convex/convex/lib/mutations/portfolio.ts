import { mutation } from "../../_generated/server"
import type { MutationCtx } from "../../_generated/server"
import type { Doc, Id } from "../../_generated/dataModel"
import { v } from "convex/values"
import {
    isTerminalOrderStatus,
    resolveProviderAdoptionInstruments,
} from "@valiq-trading/core"
import { requireServiceToken } from "../authGuards"
import { reconcileOrderInstrumentClaim, replacePositionClaims } from "../instrumentClaims"
import {
    orderStatusV,
    venueAppV,
} from "../validators"

const PORTFOLIO_STALE_AFTER_MS = 10 * 60 * 1000

const accountStateInputV = v.object({
    balance: v.number(),
    equity: v.number(),
    buyingPower: v.number(),
    marginUsed: v.number(),
    marginAvailable: v.number(),
    openPnl: v.number(),
    dayPnl: v.number(),
})

const providerPositionInputV = v.object({
    instrument: v.string(),
    side: v.union(v.literal("long"), v.literal("short")),
    quantity: v.number(),
    entryPrice: v.number(),
    currentPrice: v.optional(v.number()),
    unrealizedPnl: v.optional(v.number()),
    stopLoss: v.optional(v.number()),
    takeProfit: v.optional(v.number()),
    metadata: v.optional(v.string()),
})

const providerWorkingOrderInputV = v.object({
    orderId: v.string(),
    instrument: v.string(),
    status: orderStatusV,
    quantity: v.number(),
    filledQuantity: v.number(),
    remainingQuantity: v.number(),
    submittedAt: v.number(),
    updatedAt: v.number(),
    side: v.optional(v.union(v.literal("buy"), v.literal("sell"))),
    limitPrice: v.optional(v.number()),
    stopPrice: v.optional(v.number()),
    avgFillPrice: v.optional(v.number()),
    metadata: v.optional(v.string()),
})

type StrategyDoc = Doc<"strategies">
type OrderDoc = Doc<"orders">
type PortfolioMutationCtx = MutationCtx

interface ResolvedOwnership {
    strategyId?: Id<"strategies">
    ownershipStatus: Doc<"provider_positions">["ownershipStatus"]
}

export const reconcileProviderPortfolio = mutation({
    args: {
        serviceToken: v.string(),
        app: venueAppV,
        venue: v.string(),
        source: v.union(
            v.literal("startup_sync"),
            v.literal("periodic_sync"),
            v.literal("post_run_sync")
        ),
        accountState: accountStateInputV,
        positions: v.array(providerPositionInputV),
        workingOrders: v.array(providerWorkingOrderInputV),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)

        const now = Date.now()
        const previousState = await ctx.db
            .query("provider_sync_state")
            .withIndex("by_app", (q) => q.eq("app", args.app))
            .first()

        const strategies = await ctx.db
            .query("strategies")
            .withIndex("by_app", (q) => q.eq("app", args.app))
            .collect()

        const strategyMap = new Map(strategies.map((strategy) => [String(strategy._id), strategy]))
        const activeOrders = await listActiveOrdersForApp(ctx, strategies)
        const activeOrdersById = new Map(activeOrders.map((order) => [order.orderId, order]))
        const protectionLevelsByInstrument = buildProtectionLevels(args.workingOrders)

        const liveWorkingOrderIds = new Set(args.workingOrders.map((order) => order.orderId))
        const livePositionInstruments = new Set(args.positions.map((position) => position.instrument))
        const statusMismatches: string[] = []
        const closedPersistedOrders: string[] = []

        for (const liveOrder of args.workingOrders) {
            const existingOrder = activeOrdersById.get(liveOrder.orderId)
            if (!existingOrder) {
                continue
            }

            if (
                existingOrder.status !== liveOrder.status ||
                existingOrder.filledQuantity !== liveOrder.filledQuantity ||
                existingOrder.remainingQuantity !== liveOrder.remainingQuantity
            ) {
                statusMismatches.push(liveOrder.orderId)
            }

            await ctx.db.patch(existingOrder._id, {
                status: liveOrder.status,
                filledQuantity: liveOrder.filledQuantity,
                remainingQuantity: liveOrder.remainingQuantity,
                avgFillPrice: liveOrder.avgFillPrice,
                updatedAt: liveOrder.updatedAt,
                polling: {
                    ...existingOrder.polling,
                    lastCheckedAt: now,
                    nextCheckAt: isTerminalOrderStatus(liveOrder.status)
                        ? undefined
                        : now + existingOrder.polling.pollIntervalMs,
                    lastError: undefined,
                },
            })

            const strategy = strategyMap.get(String(existingOrder.strategyId))
            if (strategy) {
                await reconcileOrderInstrumentClaim(ctx, {
                    strategyId: existingOrder.strategyId,
                    app: strategy.app,
                    orderId: existingOrder.orderId,
                    instrument: existingOrder.instrument,
                    action: existingOrder.action,
                    status: liveOrder.status,
                    updatedAt: liveOrder.updatedAt,
                })
            }
        }

        const refreshedClaims = await ctx.db
            .query("instrument_claims")
            .withIndex("by_app", (q) => q.eq("app", args.app))
            .collect()
        const refreshedClaimsByInstrument = buildClaimsByInstrument(refreshedClaims, strategyMap)

        const resolvedPositions = args.positions.map((position) => ({
            ...position,
            stopLoss: position.stopLoss ?? protectionLevelsByInstrument.get(position.instrument)?.stopLoss,
            takeProfit: position.takeProfit ?? protectionLevelsByInstrument.get(position.instrument)?.takeProfit,
            positionKey: buildPositionKey(position),
            ...resolveOwnership({
                instrument: position.instrument,
                claimsByInstrument: refreshedClaimsByInstrument,
            }),
        }))

        const resolvedWorkingOrders = args.workingOrders.map((order) => {
            const existingOrder = activeOrdersById.get(order.orderId)
            const ownership = resolveOwnership({
                instrument: order.instrument,
                claimsByInstrument: refreshedClaimsByInstrument,
                existingOrder,
                strategyMap,
            })

            return {
                ...order,
                venue: existingOrder?.venue ?? args.venue,
                action: existingOrder?.action,
                runId: existingOrder?.runId,
                ...ownership,
            }
        })

        for (const existingOrder of activeOrders) {
            if (liveWorkingOrderIds.has(existingOrder.orderId)) {
                continue
            }

            const inferredStatus = inferClosedOrderStatus(existingOrder, livePositionInstruments)
            closedPersistedOrders.push(existingOrder.orderId)

            await ctx.db.patch(existingOrder._id, {
                status: inferredStatus,
                updatedAt: now,
                polling: {
                    ...existingOrder.polling,
                    lastCheckedAt: now,
                    nextCheckAt: undefined,
                    timedOutAt: undefined,
                    lastError: "Provider reconciliation closed this order because it is no longer live at the venue",
                },
            })

            const strategy = strategyMap.get(String(existingOrder.strategyId))
            if (strategy) {
                await reconcileOrderInstrumentClaim(ctx, {
                    strategyId: existingOrder.strategyId,
                    app: strategy.app,
                    orderId: existingOrder.orderId,
                    instrument: existingOrder.instrument,
                    action: existingOrder.action,
                    status: inferredStatus,
                    updatedAt: now,
                })
            }
        }

        await ctx.db.insert("account_snapshots", {
            app: args.app,
            venue: args.venue,
            balance: args.accountState.balance,
            equity: args.accountState.equity,
            buyingPower: args.accountState.buyingPower,
            marginUsed: args.accountState.marginUsed,
            marginAvailable: args.accountState.marginAvailable,
            openPnl: args.accountState.openPnl,
            dayPnl: args.accountState.dayPnl,
            timestamp: now,
        })

        await replaceProviderRows(ctx, "provider_positions", args.app, resolvedPositions.map((position) => ({
            app: args.app,
            positionKey: position.positionKey,
            strategyId: position.strategyId,
            ownershipStatus: position.ownershipStatus,
            instrument: position.instrument,
            side: position.side,
            quantity: position.quantity,
            entryPrice: position.entryPrice,
            currentPrice: position.currentPrice,
            unrealizedPnl: position.unrealizedPnl,
            stopLoss: position.stopLoss,
            takeProfit: position.takeProfit,
            metadata: position.metadata,
            syncedAt: now,
        })))

        await replaceProviderRows(ctx, "provider_working_orders", args.app, resolvedWorkingOrders.map((order) => ({
            app: args.app,
            orderId: order.orderId,
            strategyId: order.strategyId,
            runId: order.runId,
            ownershipStatus: order.ownershipStatus,
            venue: order.venue,
            instrument: order.instrument,
            status: order.status,
            action: order.action,
            side: order.side,
            quantity: order.quantity,
            filledQuantity: order.filledQuantity,
            remainingQuantity: order.remainingQuantity,
            limitPrice: order.limitPrice,
            stopPrice: order.stopPrice,
            avgFillPrice: order.avgFillPrice,
            metadata: order.metadata,
            submittedAt: order.submittedAt,
            updatedAt: order.updatedAt,
            syncedAt: now,
        })))

        await writeStrategyPositionSnapshots(ctx, {
            app: args.app,
            strategies,
            positions: resolvedPositions,
            syncedAt: now,
        })

        const unownedPositions = resolvedPositions.filter((position) => position.ownershipStatus !== "owned")
        const unownedOrders = resolvedWorkingOrders.filter((order) => order.ownershipStatus !== "owned")
        const driftSummary = createDriftSummary({
            unownedPositionCount: unownedPositions.length,
            unownedOrderCount: unownedOrders.length,
            closedPersistedOrders,
            statusMismatches,
        })
        const driftDetected = driftSummary !== undefined
        const stale = false
        const providerStatus = driftDetected ? "degraded" : "healthy"

        if (driftSummary && driftSummary !== previousState?.lastDriftSummary) {
            await ctx.db.insert("alerts", {
                app: args.app,
                severity: "warning",
                message: `[portfolio] ${args.app} reconciliation drift (${args.source}): ${driftSummary}`,
                acknowledged: false,
                timestamp: now,
            })
        }

        if (previousState) {
            await ctx.db.patch(previousState._id, {
                accountScope: "single-account-per-venue",
                lastSyncedAt: now,
                lastVerifiedAt: now,
                providerStatus,
                stale,
                driftDetected,
                lastError: undefined,
                lastDriftSummary: driftSummary,
                positionCount: resolvedPositions.length,
                pendingOrderCount: resolvedWorkingOrders.length,
                updatedAt: now,
            })
        } else {
            await ctx.db.insert("provider_sync_state", {
                app: args.app,
                accountScope: "single-account-per-venue",
                lastSyncedAt: now,
                lastVerifiedAt: now,
                providerStatus,
                stale,
                driftDetected,
                lastError: undefined,
                lastDriftSummary: driftSummary,
                positionCount: resolvedPositions.length,
                pendingOrderCount: resolvedWorkingOrders.length,
                updatedAt: now,
            })
        }

        return {
            app: args.app,
            source: args.source,
            positionCount: resolvedPositions.length,
            pendingOrderCount: resolvedWorkingOrders.length,
            driftDetected,
            driftSummary,
        }
    },
})

export const recordProviderSyncFailure = mutation({
    args: {
        serviceToken: v.string(),
        app: venueAppV,
        error: v.string(),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        const now = Date.now()
        const existing = await ctx.db
            .query("provider_sync_state")
            .withIndex("by_app", (q) => q.eq("app", args.app))
            .first()
        const lastVerifiedAt = existing?.lastVerifiedAt
        const stale = isStale(lastVerifiedAt, now)

        if (existing) {
            await ctx.db.patch(existing._id, {
                accountScope: "single-account-per-venue",
                providerStatus: stale ? "stale" : "degraded",
                stale,
                lastError: args.error,
                updatedAt: now,
            })
            return existing._id
        }

        return await ctx.db.insert("provider_sync_state", {
            app: args.app,
            accountScope: "single-account-per-venue",
            providerStatus: "stale",
            stale: true,
            driftDetected: false,
            lastError: args.error,
            positionCount: 0,
            pendingOrderCount: 0,
            updatedAt: now,
        })
    },
})

export const adoptProviderPositions = mutation({
    args: {
        serviceToken: v.string(),
        app: venueAppV,
        strategyId: v.id("strategies"),
        instruments: v.array(v.string()),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)

        const strategy = await ctx.db.get(args.strategyId)
        if (!strategy) {
            throw new Error(`Strategy not found: ${args.strategyId}`)
        }

        if (strategy.app !== args.app) {
            throw new Error(`Strategy ${args.strategyId} does not belong to ${args.app}`)
        }

        const requestedInstruments = Array.from(
            new Set(
                args.instruments
                    .map((instrument) => instrument.trim())
                    .filter((instrument) => instrument.length > 0)
            )
        )

        if (requestedInstruments.length === 0) {
            return {
                adoptedPositions: 0,
                adoptedOrders: 0,
            }
        }

        const instrumentSet = new Set(requestedInstruments)
        const appStrategies = await ctx.db
            .query("strategies")
            .withIndex("by_app", (q) => q.eq("app", args.app))
            .collect()
        const activeOrders = await listActiveOrdersForApp(ctx, appStrategies)
        const conflictingOrders = activeOrders.filter(
            (order) =>
                instrumentSet.has(order.instrument) &&
                order.strategyId !== args.strategyId
        )

        if (conflictingOrders.length > 0) {
            throw new Error(
                `Cannot adopt instruments with active Convex-tracked orders owned by another strategy: ${conflictingOrders.map((order) => `${order.instrument}:${order.orderId}`).join(", ")}`
            )
        }

        const [claims, providerPositions, providerWorkingOrders] = await Promise.all([
            ctx.db
                .query("instrument_claims")
                .withIndex("by_app", (q) => q.eq("app", args.app))
                .collect(),
            ctx.db
                .query("provider_positions")
                .withIndex("by_app", (q) => q.eq("app", args.app))
                .collect(),
            ctx.db
                .query("provider_working_orders")
                .withIndex("by_app", (q) => q.eq("app", args.app))
                .collect(),
        ])

        const instruments = resolveProviderAdoptionInstruments({
            targetStrategyId: String(args.strategyId),
            requestedInstruments,
            rows: [
                ...providerPositions.map((position) => ({
                    instrument: position.instrument,
                    ownershipStatus: position.ownershipStatus,
                    strategyId: position.strategyId ? String(position.strategyId) : undefined,
                })),
                ...providerWorkingOrders.map((order) => ({
                    instrument: order.instrument,
                    ownershipStatus: order.ownershipStatus,
                    strategyId: order.strategyId ? String(order.strategyId) : undefined,
                })),
            ],
            claims: claims.map((claim) => ({
                instrument: claim.instrument,
                strategyId: String(claim.strategyId),
            })),
        })

        const now = Date.now()

        for (const claim of claims) {
            if (instrumentSet.has(claim.instrument)) {
                await ctx.db.delete(claim._id)
            }
        }

        for (const instrument of instruments) {
            await ctx.db.insert("instrument_claims", {
                strategyId: args.strategyId,
                app: args.app,
                instrument,
                source: "position",
                sourceId: instrument,
                updatedAt: now,
            })
        }

        let adoptedPositions = 0
        for (const position of providerPositions) {
            if (!instrumentSet.has(position.instrument)) {
                continue
            }

            await ctx.db.patch(position._id, {
                strategyId: args.strategyId,
                ownershipStatus: "owned",
            })
            adoptedPositions++
        }

        let adoptedOrders = 0
        for (const order of providerWorkingOrders) {
            if (!instrumentSet.has(order.instrument)) {
                continue
            }

            await ctx.db.patch(order._id, {
                strategyId: args.strategyId,
                ownershipStatus: "owned",
            })
            adoptedOrders++
        }

        await updateProviderSyncStateFromCurrentRows(ctx, args.app, now)

        return {
            adoptedPositions,
            adoptedOrders,
        }
    },
})

function buildClaimsByInstrument(
    claims: Array<Doc<"instrument_claims">>,
    strategyMap: Map<string, StrategyDoc>
): Map<string, Set<Id<"strategies">>> {
    const claimsByInstrument = new Map<string, Set<Id<"strategies">>>()

    for (const claim of claims) {
        if (!strategyMap.has(String(claim.strategyId))) {
            continue
        }

        const existing = claimsByInstrument.get(claim.instrument) ?? new Set<Id<"strategies">>()
        existing.add(claim.strategyId)
        claimsByInstrument.set(claim.instrument, existing)
    }

    return claimsByInstrument
}

async function updateProviderSyncStateFromCurrentRows(
    ctx: PortfolioMutationCtx,
    app: Doc<"strategies">["app"],
    now: number
): Promise<void> {
    const [state, positions, orders] = await Promise.all([
        ctx.db
            .query("provider_sync_state")
            .withIndex("by_app", (q) => q.eq("app", app))
            .first(),
        ctx.db
            .query("provider_positions")
            .withIndex("by_app", (q) => q.eq("app", app))
            .collect(),
        ctx.db
            .query("provider_working_orders")
            .withIndex("by_app", (q) => q.eq("app", app))
            .collect(),
    ])

    if (!state) {
        return
    }

    const unownedPositionCount = positions.filter((position) => position.ownershipStatus !== "owned").length
    const unownedOrderCount = orders.filter((order) => order.ownershipStatus !== "owned").length
    const driftSummary = createDriftSummary({
        unownedPositionCount,
        unownedOrderCount,
        closedPersistedOrders: [],
        statusMismatches: [],
    })
    const driftDetected = driftSummary !== undefined
    const stale = isStale(state.lastVerifiedAt, now)

    await ctx.db.patch(state._id, {
        providerStatus: stale
            ? "stale"
            : driftDetected
                ? "degraded"
                : "healthy",
        stale,
        driftDetected,
        lastDriftSummary: driftSummary,
        positionCount: positions.length,
        pendingOrderCount: orders.length,
        updatedAt: now,
    })
}

async function listActiveOrdersForApp(
    ctx: PortfolioMutationCtx,
    strategies: StrategyDoc[]
): Promise<OrderDoc[]> {
    const activeOrders: OrderDoc[] = []

    for (const strategy of strategies) {
        const [pending, partiallyFilled] = await Promise.all([
            ctx.db
                .query("orders")
                .withIndex("by_strategy_status", (q) =>
                    q.eq("strategyId", strategy._id).eq("status", "pending")
                )
                .collect(),
            ctx.db
                .query("orders")
                .withIndex("by_strategy_status", (q) =>
                    q.eq("strategyId", strategy._id).eq("status", "partially_filled")
                )
                .collect(),
        ])

        activeOrders.push(...pending, ...partiallyFilled)
    }

    return activeOrders
}

function resolveOwnership(args: {
    instrument: string
    claimsByInstrument: Map<string, Set<Id<"strategies">>>
    existingOrder?: OrderDoc
    strategyMap?: Map<string, StrategyDoc>
}): ResolvedOwnership {
    if (args.existingOrder) {
        if (!args.strategyMap || args.strategyMap.has(String(args.existingOrder.strategyId))) {
            return {
                strategyId: args.existingOrder.strategyId,
                ownershipStatus: "owned",
            }
        }

        return {
            ownershipStatus: "orphaned",
        }
    }

    const claims = args.claimsByInstrument.get(args.instrument)
    if (!claims || claims.size === 0) {
        return { ownershipStatus: "unowned" }
    }

    if (claims.size > 1) {
        return { ownershipStatus: "orphaned" }
    }

    const [strategyId] = Array.from(claims)
    return {
        strategyId,
        ownershipStatus: "owned",
    }
}

function buildPositionKey(position: {
    instrument: string
    side: string
}): string {
    return `${position.instrument}:${position.side}`
}

function inferClosedOrderStatus(
    order: OrderDoc,
    _livePositionInstruments: Set<string>
): Doc<"orders">["status"] {
    if (order.filledQuantity > 0) {
        return "filled"
    }

    return "cancelled"
}

async function replaceProviderRows(
    ctx: PortfolioMutationCtx,
    table: "provider_positions" | "provider_working_orders",
    app: Doc<"strategies">["app"],
    rows: Array<Record<string, unknown>>
): Promise<void> {
    const existing = table === "provider_positions"
        ? await ctx.db
            .query("provider_positions")
            .withIndex("by_app", (q) => q.eq("app", app))
            .collect()
        : await ctx.db
            .query("provider_working_orders")
            .withIndex("by_app", (q) => q.eq("app", app))
            .collect()

    for (const row of existing) {
        await ctx.db.delete(row._id)
    }

    for (const row of rows) {
        if (table === "provider_positions") {
            await ctx.db.insert("provider_positions", row as never)
        } else {
            await ctx.db.insert("provider_working_orders", row as never)
        }
    }
}

async function writeStrategyPositionSnapshots(
    ctx: PortfolioMutationCtx,
    args: {
        app: Doc<"strategies">["app"]
        strategies: StrategyDoc[]
        positions: Array<{
            strategyId?: Id<"strategies">
            instrument: string
            side: "long" | "short"
            quantity: number
            entryPrice: number
            currentPrice?: number
            unrealizedPnl?: number
            stopLoss?: number
            takeProfit?: number
            metadata?: string
        }>
        syncedAt: number
    }
): Promise<void> {
    const positionsByStrategy = new Map<string, typeof args.positions>()

    for (const position of args.positions) {
        if (!position.strategyId) {
            continue
        }

        const key = String(position.strategyId)
        const existing = positionsByStrategy.get(key) ?? []
        existing.push(position)
        positionsByStrategy.set(key, existing)
    }

    for (const strategy of args.strategies) {
        if (isDryRunStrategy(strategy)) {
            continue
        }

        const strategyPositions = positionsByStrategy.get(String(strategy._id)) ?? []

        await ctx.db.insert("position_syncs", {
            strategyId: strategy._id,
            app: args.app,
            syncedAt: args.syncedAt,
            positionCount: strategyPositions.length,
        })

        for (const position of strategyPositions) {
            await ctx.db.insert("positions", {
                strategyId: strategy._id,
                app: args.app,
                instrument: position.instrument,
                side: position.side,
                quantity: position.quantity,
                entryPrice: position.entryPrice,
                currentPrice: position.currentPrice,
                unrealizedPnl: position.unrealizedPnl,
                metadata: position.metadata,
                syncedAt: args.syncedAt,
            })
        }

        await replacePositionClaims(ctx, {
            strategyId: strategy._id,
            app: args.app,
            instruments: strategyPositions.map((position) => position.instrument),
            updatedAt: args.syncedAt,
        })
    }
}

function isDryRunStrategy(strategy: StrategyDoc): boolean {
    return Boolean((strategy.policy as Record<string, unknown>).dryRun)
}

function createDriftSummary(args: {
    unownedPositionCount: number
    unownedOrderCount: number
    closedPersistedOrders: string[]
    statusMismatches: string[]
}): string | undefined {
    const parts: string[] = []

    if (args.unownedPositionCount > 0) {
        parts.push(`${args.unownedPositionCount} live position(s) lack a clean strategy owner`)
    }

    if (args.unownedOrderCount > 0) {
        parts.push(`${args.unownedOrderCount} live working order(s) lack a clean strategy owner`)
    }

    if (args.closedPersistedOrders.length > 0) {
        parts.push(`${args.closedPersistedOrders.length} Convex-tracked working order(s) were no longer live at the provider`)
    }

    if (args.statusMismatches.length > 0) {
        parts.push(`${args.statusMismatches.length} working order(s) required status or quantity repair`)
    }

    return parts.length > 0 ? parts.join("; ") : undefined
}

function isStale(lastVerifiedAt: number | undefined, now: number): boolean {
    if (!lastVerifiedAt) {
        return true
    }

    return now - lastVerifiedAt > PORTFOLIO_STALE_AFTER_MS
}

function buildProtectionLevels(
    orders: Array<{
        instrument: string
        stopPrice?: number
        metadata?: string
    }>
): Map<string, { stopLoss?: number; takeProfit?: number }> {
    const levels = new Map<string, { stopLoss?: number; takeProfit?: number }>()

    for (const order of orders) {
        const metadata = parseJson<Record<string, unknown>>(order.metadata)
        const orderType = typeof metadata?.type === "string" ? metadata.type : undefined
        const current = levels.get(order.instrument) ?? {}

        if (orderType === "STOP_MARKET" || orderType === "STOP") {
            current.stopLoss = order.stopPrice
        }

        if (orderType === "TAKE_PROFIT_MARKET" || orderType === "TAKE_PROFIT") {
            current.takeProfit = order.stopPrice
        }

        levels.set(order.instrument, current)
    }

    return levels
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

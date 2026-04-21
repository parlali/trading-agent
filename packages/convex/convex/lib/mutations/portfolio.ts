import { mutation } from "../../_generated/server"
import type { MutationCtx } from "../../_generated/server"
import type { Doc, Id } from "../../_generated/dataModel"
import { v } from "convex/values"
import {
    isTerminalOrderStatus,
    resolveProviderAdoptionInstruments,
} from "@valiq-trading/core"
import { requireServiceToken } from "../authGuards"
import {
    getClaimInstrumentsForOrder,
    reconcileOrderInstrumentClaim,
    replacePositionClaims,
    upsertPositionInstrumentClaims,
} from "../instrumentClaims"
import {
    buildPositionClaim,
    buildProviderPositionKey,
    resolveProviderPositionId,
} from "../providerPositions"
import {
    orderStatusV,
    venueAppV,
} from "../validators"
import { incrementControlPlaneMetric } from "../controlPlaneMetrics"

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
    providerPositionId: v.optional(v.string()),
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
    cancelAt: v.optional(v.number()),
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
        const expectedExternalInstruments = collectExpectedExternalInstruments(strategies)
        const existingProviderPositions = await ctx.db
            .query("provider_positions")
            .withIndex("by_app", (q) => q.eq("app", args.app))
            .collect()
        const existingProviderPositionsByKey = new Map(
            existingProviderPositions.map((position) => [position.positionKey, position])
        )

        const liveWorkingOrderIds = new Set(args.workingOrders.map((order) => order.orderId))
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
                    claimInstruments: getClaimInstrumentsForOrder(existingOrder.instrument, existingOrder.intent),
                    action: existingOrder.action,
                    status: liveOrder.status,
                    updatedAt: liveOrder.updatedAt,
                })
            }
        }

        await repairMissingLivePositionClaimsFromFilledOrders(ctx, {
            app: args.app,
            strategyMap,
            liveInstruments: new Set([
                ...args.positions.map((position) => position.instrument),
                ...args.workingOrders.map((order) => order.instrument),
            ]),
            updatedAt: now,
        })

        const refreshedClaims = await ctx.db
            .query("instrument_claims")
            .withIndex("by_app", (q) => q.eq("app", args.app))
            .collect()
        const refreshedClaimsByInstrument = buildClaimsByInstrument(refreshedClaims, strategyMap)
        const refreshedPositionClaimsByKey = buildPositionClaimsByKey(refreshedClaims, strategyMap)
        const ownershipMismatches = new Set<string>()

        const resolvedPositions = args.positions.map((position) => {
            const positionKey = buildProviderPositionKey(position)
            const previousPosition = existingProviderPositionsByKey.get(positionKey)
            const ownership = resolveOwnership({
                instrument: position.instrument,
                positionKey,
                claimsByInstrument: refreshedClaimsByInstrument,
                claimsByPositionKey: refreshedPositionClaimsByKey,
                existingPositionByKey: existingProviderPositionsByKey,
                strategyMap,
            })
            const expectedExternal = ownership.ownershipStatus !== "owned" && isExpectedExternalProviderRow(
                expectedExternalInstruments,
                position
            )

            if (
                hasPositionOwnershipMismatch({
                    positionKey,
                    claimsByPositionKey: refreshedPositionClaimsByKey,
                    existingPositionByKey: existingProviderPositionsByKey,
                    strategyMap,
                }) ||
                previousPosition?.strategyId &&
                (
                    ownership.ownershipStatus !== "owned" ||
                    ownership.strategyId !== previousPosition.strategyId
                )
            ) {
                ownershipMismatches.add(positionKey)
            }

            return {
                ...position,
                stopLoss: position.stopLoss ?? protectionLevelsByInstrument.get(position.instrument)?.stopLoss,
                takeProfit: position.takeProfit ?? protectionLevelsByInstrument.get(position.instrument)?.takeProfit,
                positionKey,
                expectedExternal,
                ...ownership,
            }
        })

        const resolvedWorkingOrders = args.workingOrders.map((order) => {
            const existingOrder = activeOrdersById.get(order.orderId)
            const ownership = resolveOwnership({
                instrument: order.instrument,
                claimsByInstrument: refreshedClaimsByInstrument,
                existingOrder,
                strategyMap,
            })
            const expectedExternal = ownership.ownershipStatus !== "owned" && isExpectedExternalProviderRow(
                expectedExternalInstruments,
                order
            )

            return {
                ...order,
                venue: existingOrder?.venue ?? args.venue,
                action: existingOrder?.action,
                runId: existingOrder?.runId,
                cancelAt: order.cancelAt ?? readOrderCancelAt(existingOrder),
                expectedExternal,
                ...ownership,
            }
        })

        for (const existingOrder of activeOrders) {
            if (liveWorkingOrderIds.has(existingOrder.orderId)) {
                continue
            }

            const inferredResolution = inferClosedOrderStatus({
                app: args.app,
                order: existingOrder,
                livePositions: args.positions,
            })
            closedPersistedOrders.push(existingOrder.orderId)

            await ctx.db.patch(existingOrder._id, {
                status: inferredResolution.status,
                filledQuantity: inferredResolution.filledQuantity ?? existingOrder.filledQuantity,
                remainingQuantity: inferredResolution.remainingQuantity ?? existingOrder.remainingQuantity,
                avgFillPrice: inferredResolution.avgFillPrice ?? existingOrder.avgFillPrice,
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
                    claimInstruments: getClaimInstrumentsForOrder(existingOrder.instrument, existingOrder.intent),
                    action: existingOrder.action,
                    status: inferredResolution.status,
                    updatedAt: now,
                })
            }
        }

        const nextProviderPositions = resolvedPositions.map((position) => ({
            app: args.app,
            positionKey: position.positionKey,
            providerPositionId: position.providerPositionId,
            strategyId: position.strategyId,
            ownershipStatus: position.ownershipStatus,
            expectedExternal: position.expectedExternal,
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
        }))

        const nextProviderWorkingOrders = resolvedWorkingOrders.map((order) => ({
            app: args.app,
            orderId: order.orderId,
            strategyId: order.strategyId,
            runId: order.runId,
            ownershipStatus: order.ownershipStatus,
            expectedExternal: order.expectedExternal,
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
            cancelAt: order.cancelAt,
            syncedAt: now,
        }))

        const accountSnapshotHash = computeHash({
            venue: args.venue,
            accountState: args.accountState,
        })
        const shouldWriteAccountSnapshot = previousState?.lastAccountSnapshotHash !== accountSnapshotHash
        const accountSnapshotDecision = shouldWriteAccountSnapshot
            ? "written:account_state_changed"
            : "skipped:account_state_unchanged"

        if (shouldWriteAccountSnapshot) {
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
        }

        const providerPositionWriteStats = await upsertProviderPositionRows(ctx, args.app, nextProviderPositions)
        const providerWorkingOrderWriteStats = await upsertProviderWorkingOrderRows(ctx, args.app, nextProviderWorkingOrders)

        const positionSnapshotResult = await writeStrategyPositionSnapshots(ctx, {
            app: args.app,
            strategies,
            positions: resolvedPositions,
            syncedAt: now,
        })
        const positionSnapshotHash = computeHash(positionSnapshotResult.hashInput)
        const positionSnapshotDecision = positionSnapshotResult.decision

        await incrementControlPlaneMetric(ctx, {
            metric: shouldWriteAccountSnapshot ? "reconcile_provider_portfolio.account_snapshot_written" : "reconcile_provider_portfolio.account_snapshot_suppressed",
            app: args.app,
        })
        await incrementControlPlaneMetric(ctx, {
            metric: "reconcile_provider_portfolio.provider_positions_inserted",
            app: args.app,
            delta: providerPositionWriteStats.inserted,
        })
        await incrementControlPlaneMetric(ctx, {
            metric: "reconcile_provider_portfolio.provider_positions_patched",
            app: args.app,
            delta: providerPositionWriteStats.patched,
        })
        await incrementControlPlaneMetric(ctx, {
            metric: "reconcile_provider_portfolio.provider_positions_deleted",
            app: args.app,
            delta: providerPositionWriteStats.deleted,
        })
        await incrementControlPlaneMetric(ctx, {
            metric: "reconcile_provider_portfolio.provider_positions_unchanged",
            app: args.app,
            delta: providerPositionWriteStats.unchanged,
        })
        await incrementControlPlaneMetric(ctx, {
            metric: "reconcile_provider_portfolio.provider_orders_inserted",
            app: args.app,
            delta: providerWorkingOrderWriteStats.inserted,
        })
        await incrementControlPlaneMetric(ctx, {
            metric: "reconcile_provider_portfolio.provider_orders_patched",
            app: args.app,
            delta: providerWorkingOrderWriteStats.patched,
        })
        await incrementControlPlaneMetric(ctx, {
            metric: "reconcile_provider_portfolio.provider_orders_deleted",
            app: args.app,
            delta: providerWorkingOrderWriteStats.deleted,
        })
        await incrementControlPlaneMetric(ctx, {
            metric: "reconcile_provider_portfolio.provider_orders_unchanged",
            app: args.app,
            delta: providerWorkingOrderWriteStats.unchanged,
        })
        await incrementControlPlaneMetric(ctx, {
            metric: "reconcile_provider_portfolio.strategy_snapshots_written",
            app: args.app,
            delta: positionSnapshotResult.stats.written,
        })
        await incrementControlPlaneMetric(ctx, {
            metric: "reconcile_provider_portfolio.strategy_snapshots_skipped",
            app: args.app,
            delta: positionSnapshotResult.stats.skipped,
        })

        const unownedPositions = resolvedPositions.filter((position) =>
            position.ownershipStatus !== "owned" && position.expectedExternal !== true
        )
        const unownedOrders = resolvedWorkingOrders.filter((order) =>
            order.ownershipStatus !== "owned" && order.expectedExternal !== true
        )
        const driftSummary = createDriftSummary({
            unownedPositionCount: unownedPositions.length,
            unownedOrderCount: unownedOrders.length,
            closedPersistedOrders,
            statusMismatches,
            ownershipMismatches: Array.from(ownershipMismatches),
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
                lastAccountSnapshotHash: accountSnapshotHash,
                lastAccountSnapshotDecision: accountSnapshotDecision,
                lastPositionSnapshotHash: positionSnapshotHash,
                lastPositionSnapshotDecision: positionSnapshotDecision,
                lastReconciliationWriteStats: {
                    accountSnapshotWritten: shouldWriteAccountSnapshot,
                    providerPositions: providerPositionWriteStats,
                    providerWorkingOrders: providerWorkingOrderWriteStats,
                    strategySnapshots: positionSnapshotResult.stats,
                },
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
                lastAccountSnapshotHash: accountSnapshotHash,
                lastAccountSnapshotDecision: accountSnapshotDecision,
                lastPositionSnapshotHash: positionSnapshotHash,
                lastPositionSnapshotDecision: positionSnapshotDecision,
                lastReconciliationWriteStats: {
                    accountSnapshotWritten: shouldWriteAccountSnapshot,
                    providerPositions: providerPositionWriteStats,
                    providerWorkingOrders: providerWorkingOrderWriteStats,
                    strategySnapshots: positionSnapshotResult.stats,
                },
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

        const conflictingProviderPositions = providerPositions.filter(
            (position) =>
                instrumentSet.has(position.instrument) &&
                position.strategyId &&
                position.strategyId !== args.strategyId
        )
        const conflictingProviderWorkingOrders = providerWorkingOrders.filter(
            (order) =>
                instrumentSet.has(order.instrument) &&
                order.strategyId &&
                order.strategyId !== args.strategyId
        )

        if (conflictingProviderPositions.length > 0 || conflictingProviderWorkingOrders.length > 0) {
            const conflictingPositionIds = conflictingProviderPositions.map((position) => position.positionKey)
            const conflictingOrderIds = conflictingProviderWorkingOrders.map((order) => order.orderId)
            throw new Error(
                `Cannot adopt instruments already owned by another strategy. Conflicting provider positions: ${conflictingPositionIds.join(", ") || "none"}; conflicting provider working orders: ${conflictingOrderIds.join(", ") || "none"}`
            )
        }

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

        const adoptedPositionClaims = buildAdoptedPositionClaims({
            strategyId: args.strategyId,
            requestedInstruments: instruments,
            providerPositions,
            existingClaims: claims,
        })

        await replacePositionClaims(ctx, {
            strategyId: args.strategyId,
            app: args.app,
            positionClaims: adoptedPositionClaims,
            updatedAt: now,
        })

        let adoptedPositions = 0
        for (const position of providerPositions) {
            if (!instrumentSet.has(position.instrument)) {
                continue
            }

            await ctx.db.patch(position._id, {
                strategyId: args.strategyId,
                ownershipStatus: "owned",
                expectedExternal: false,
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
                expectedExternal: false,
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

function buildPositionClaimsByKey(
    claims: Array<Doc<"instrument_claims">>,
    strategyMap: Map<string, StrategyDoc>
): Map<string, Set<Id<"strategies">>> {
    const claimsByPositionKey = new Map<string, Set<Id<"strategies">>>()

    for (const claim of claims) {
        if (claim.source !== "position" || !strategyMap.has(String(claim.strategyId))) {
            continue
        }

        const positionKey = claim.sourceId.trim()
        if (positionKey.length === 0) {
            continue
        }

        const existing = claimsByPositionKey.get(positionKey) ?? new Set<Id<"strategies">>()
        existing.add(claim.strategyId)
        claimsByPositionKey.set(positionKey, existing)
    }

    return claimsByPositionKey
}

function buildAdoptedPositionClaims(args: {
    strategyId: Id<"strategies">
    requestedInstruments: string[]
    providerPositions: Array<Doc<"provider_positions">>
    existingClaims: Array<Doc<"instrument_claims">>
}): Array<{ instrument: string; sourceId: string }> {
    const instrumentSet = new Set(args.requestedInstruments)
    const adoptedClaims = args.providerPositions
        .filter((position) => instrumentSet.has(position.instrument))
        .map((position) => ({
            instrument: position.instrument,
            sourceId: position.positionKey,
        }))

    const preservedClaims = args.existingClaims
        .filter((claim) =>
            claim.strategyId === args.strategyId &&
            claim.source === "position" &&
            !instrumentSet.has(claim.instrument)
        )
        .map((claim) => ({
            instrument: claim.instrument,
            sourceId: claim.sourceId,
        }))

    return [...preservedClaims, ...adoptedClaims]
}

function collectExpectedExternalInstruments(
    strategies: StrategyDoc[]
): Set<string> {
    const expected = new Set<string>()

    for (const strategy of strategies) {
        const safetyPolicy = (strategy.policy as Record<string, unknown>).safety as Record<string, unknown> | undefined
        const expectedInstruments = safetyPolicy?.expectedExternalInstruments

        if (!Array.isArray(expectedInstruments)) {
            continue
        }

        for (const value of expectedInstruments) {
            if (typeof value !== "string") {
                continue
            }

            const instrument = value.trim()
            if (instrument.length === 0) {
                continue
            }

            expected.add(instrument)
        }
    }

    return expected
}

function readMetadataRecord(value: string | undefined): Record<string, unknown> | undefined {
    if (!value) {
        return undefined
    }

    try {
        const parsed = JSON.parse(value)
        return parsed && typeof parsed === "object"
            ? parsed as Record<string, unknown>
            : undefined
    } catch {
        return undefined
    }
}

function addExpectedExternalIdentifier(
    identifiers: Set<string>,
    value: unknown
): void {
    if (typeof value !== "string") {
        return
    }

    const normalized = value.trim()
    if (normalized.length === 0) {
        return
    }

    identifiers.add(normalized)
}

function isExpectedExternalProviderRow(
    expectedExternalInstruments: Set<string>,
    row: {
        instrument: string
        metadata?: string
    }
): boolean {
    if (expectedExternalInstruments.has(row.instrument)) {
        return true
    }

    const metadata = readMetadataRecord(row.metadata)
    if (!metadata) {
        return false
    }

    const identifiers = new Set<string>()
    addExpectedExternalIdentifier(identifiers, metadata.tokenId)
    addExpectedExternalIdentifier(identifiers, metadata.marketSlug)
    addExpectedExternalIdentifier(identifiers, metadata.slug)
    addExpectedExternalIdentifier(identifiers, metadata.conditionId)
    addExpectedExternalIdentifier(identifiers, metadata.market)

    for (const identifier of identifiers) {
        if (expectedExternalInstruments.has(identifier)) {
            return true
        }
    }

    return false
}

async function repairMissingLivePositionClaimsFromFilledOrders(
    ctx: PortfolioMutationCtx,
    args: {
        app: Doc<"strategies">["app"]
        strategyMap: Map<string, StrategyDoc>
        liveInstruments: Set<string>
        updatedAt: number
    }
): Promise<void> {
    if (args.liveInstruments.size === 0) {
        return
    }

    const [existingClaims, filledOrders] = await Promise.all([
        ctx.db
            .query("instrument_claims")
            .withIndex("by_app", (q) => q.eq("app", args.app))
            .collect(),
        ctx.db
            .query("orders")
            .withIndex("by_app_status", (q) => q.eq("app", args.app).eq("status", "filled"))
            .collect(),
    ])

    const claimedInstruments = new Set(existingClaims.map((claim) => claim.instrument))
    const candidateStrategiesByInstrument = new Map<string, Set<Id<"strategies">>>()

    for (const order of filledOrders) {
        if (!isEntryLikeOrder(order) || !args.strategyMap.has(String(order.strategyId))) {
            continue
        }

        const instruments = getClaimInstrumentsForOrder(order.instrument, order.intent)
        for (const instrument of instruments) {
            if (!args.liveInstruments.has(instrument) || claimedInstruments.has(instrument)) {
                continue
            }

            const strategies = candidateStrategiesByInstrument.get(instrument) ?? new Set<Id<"strategies">>()
            strategies.add(order.strategyId)
            candidateStrategiesByInstrument.set(instrument, strategies)
        }
    }

    const instrumentsByStrategy = new Map<string, { strategyId: Id<"strategies">; instruments: string[] }>()

    for (const [instrument, strategies] of candidateStrategiesByInstrument) {
        if (strategies.size !== 1) {
            continue
        }

        const [strategyId] = Array.from(strategies)
        if (!strategyId) {
            continue
        }

        const key = String(strategyId)
        const entry = instrumentsByStrategy.get(key) ?? { strategyId, instruments: [] }
        entry.instruments.push(instrument)
        instrumentsByStrategy.set(key, entry)
    }

    for (const entry of instrumentsByStrategy.values()) {
        await upsertPositionInstrumentClaims(ctx, {
            strategyId: entry.strategyId,
            app: args.app,
            instruments: entry.instruments,
            updatedAt: args.updatedAt,
        })
    }
}

function isEntryLikeOrder(order: OrderDoc): boolean {
    return order.action === "entry" || order.action === "adjustment"
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

    const unownedPositionCount = positions.filter((position) =>
        position.ownershipStatus !== "owned" && position.expectedExternal !== true
    ).length
    const unownedOrderCount = orders.filter((order) =>
        order.ownershipStatus !== "owned" && order.expectedExternal !== true
    ).length
    const driftSummary = createDriftSummary({
        unownedPositionCount,
        unownedOrderCount,
        closedPersistedOrders: [],
        statusMismatches: [],
        ownershipMismatches: [],
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
    positionKey?: string
    claimsByInstrument: Map<string, Set<Id<"strategies">>>
    claimsByPositionKey?: Map<string, Set<Id<"strategies">>>
    existingOrder?: OrderDoc
    existingPositionByKey?: Map<string, Doc<"provider_positions">>
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

    if (args.positionKey && (args.existingPositionByKey || args.claimsByPositionKey)) {
        const positionOwnership = resolvePositionOwnership({
            positionKey: args.positionKey,
            claimsByPositionKey: args.claimsByPositionKey,
            existingPositionByKey: args.existingPositionByKey,
            strategyMap: args.strategyMap,
        })
        if (positionOwnership) {
            return positionOwnership
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

function resolvePositionOwnership(args: {
    positionKey: string
    claimsByPositionKey?: Map<string, Set<Id<"strategies">>>
    existingPositionByKey?: Map<string, Doc<"provider_positions">>
    strategyMap?: Map<string, StrategyDoc>
}): ResolvedOwnership | undefined {
    const existingStrategyId = readKnownStrategyId(
        args.existingPositionByKey?.get(args.positionKey)?.strategyId,
        args.strategyMap
    )
    const claims = args.claimsByPositionKey?.get(args.positionKey)

    if (claims && claims.size > 1) {
        return {
            ownershipStatus: "orphaned",
        }
    }

    const [claimedStrategyId] = claims ? Array.from(claims) : []
    const knownClaimedStrategyId = readKnownStrategyId(claimedStrategyId, args.strategyMap)

    if (existingStrategyId && claimedStrategyId && !knownClaimedStrategyId) {
        return {
            ownershipStatus: "orphaned",
        }
    }

    if (existingStrategyId && knownClaimedStrategyId && existingStrategyId !== knownClaimedStrategyId) {
        return {
            ownershipStatus: "orphaned",
        }
    }

    if (knownClaimedStrategyId) {
        return {
            strategyId: knownClaimedStrategyId,
            ownershipStatus: "owned",
        }
    }

    if (existingStrategyId) {
        return {
            strategyId: existingStrategyId,
            ownershipStatus: "owned",
        }
    }

    if (claimedStrategyId) {
        return {
            ownershipStatus: "orphaned",
        }
    }

    return undefined
}

function hasPositionOwnershipMismatch(args: {
    positionKey: string
    claimsByPositionKey?: Map<string, Set<Id<"strategies">>>
    existingPositionByKey?: Map<string, Doc<"provider_positions">>
    strategyMap?: Map<string, StrategyDoc>
}): boolean {
    const claims = args.claimsByPositionKey?.get(args.positionKey)
    if (claims && claims.size > 1) {
        return true
    }

    const existingStrategyId = readKnownStrategyId(
        args.existingPositionByKey?.get(args.positionKey)?.strategyId,
        args.strategyMap
    )
    const [claimedStrategyId] = claims ? Array.from(claims) : []
    const knownClaimedStrategyId = readKnownStrategyId(claimedStrategyId, args.strategyMap)

    if (existingStrategyId && claimedStrategyId && !knownClaimedStrategyId) {
        return true
    }

    return Boolean(
        existingStrategyId &&
        knownClaimedStrategyId &&
        existingStrategyId !== knownClaimedStrategyId
    )
}

function readKnownStrategyId(
    strategyId: Id<"strategies"> | undefined,
    strategyMap?: Map<string, StrategyDoc>
): Id<"strategies"> | undefined {
    if (!strategyId) {
        return undefined
    }

    if (!strategyMap || strategyMap.has(String(strategyId))) {
        return strategyId
    }

    return undefined
}

function inferClosedOrderStatus(args: {
    app: Doc<"strategies">["app"]
    order: OrderDoc
    livePositions: Array<{
        instrument: string
        side: "long" | "short"
        quantity: number
        entryPrice: number
        metadata?: string
    }>
}): {
    status: Doc<"orders">["status"]
    filledQuantity?: number
    remainingQuantity?: number
    avgFillPrice?: number
} {
    const order = args.order

    if (order.filledQuantity > 0) {
        return {
            status: "filled",
            filledQuantity: order.filledQuantity,
            remainingQuantity: Math.max(order.quantity - order.filledQuantity, 0),
            avgFillPrice: order.avgFillPrice,
        }
    }

    if (args.app === "mt5") {
        const matchingPosition = args.livePositions.find((position) =>
            position.instrument === order.instrument &&
            mt5PositionMatchesOrderDirection(order, position.side) &&
            extractMt5Ticket(position.metadata) === order.orderId
        )

        if (matchingPosition) {
            const resolvedFilledQuantity = matchingPosition.quantity > 0
                ? Math.min(order.quantity, matchingPosition.quantity)
                : order.quantity

            return {
                status: "filled",
                filledQuantity: resolvedFilledQuantity,
                remainingQuantity: Math.max(order.quantity - resolvedFilledQuantity, 0),
                avgFillPrice: matchingPosition.entryPrice > 0
                    ? matchingPosition.entryPrice
                    : order.avgFillPrice,
            }
        }
    }

    return {
        status: "cancelled",
    }
}

function mt5PositionMatchesOrderDirection(order: OrderDoc, side: "long" | "short"): boolean {
    if (order.intent.side === "buy") {
        return side === "long"
    }
    if (order.intent.side === "sell") {
        return side === "short"
    }
    return true
}

function extractMt5Ticket(metadata?: string): string | undefined {
    if (!metadata) {
        return undefined
    }

    try {
        const parsed = JSON.parse(metadata) as { ticket?: unknown }
        if (typeof parsed.ticket === "number" || typeof parsed.ticket === "string") {
            return String(parsed.ticket)
        }
    } catch {
        return undefined
    }

    return undefined
}

async function upsertProviderPositionRows(
    ctx: PortfolioMutationCtx,
    app: Doc<"strategies">["app"],
    rows: Array<Omit<Doc<"provider_positions">, "_id" | "_creationTime">>
): Promise<{ inserted: number; patched: number; deleted: number; unchanged: number }> {
    const existing = await ctx.db
        .query("provider_positions")
        .withIndex("by_app", (q) => q.eq("app", app))
        .collect()

    const existingByKey = new Map(existing.map((row) => [row.positionKey, row]))
    const nextKeySet = new Set(rows.map((row) => row.positionKey))
    const stats = {
        inserted: 0,
        patched: 0,
        deleted: 0,
        unchanged: 0,
    }

    for (const row of rows) {
        const current = existingByKey.get(row.positionKey)
        if (!current) {
            await ctx.db.insert("provider_positions", row)
            stats.inserted++
            continue
        }

        const changed = (
            current.providerPositionId !== row.providerPositionId ||
            current.strategyId !== row.strategyId ||
            current.ownershipStatus !== row.ownershipStatus ||
            current.expectedExternal !== row.expectedExternal ||
            current.instrument !== row.instrument ||
            current.side !== row.side ||
            current.quantity !== row.quantity ||
            current.entryPrice !== row.entryPrice ||
            current.currentPrice !== row.currentPrice ||
            current.unrealizedPnl !== row.unrealizedPnl ||
            current.stopLoss !== row.stopLoss ||
            current.takeProfit !== row.takeProfit ||
            current.metadata !== row.metadata ||
            current.syncedAt !== row.syncedAt
        )

        if (!changed) {
            stats.unchanged++
            continue
        }

        await ctx.db.patch(current._id, {
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
            syncedAt: row.syncedAt,
        })
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

async function upsertProviderWorkingOrderRows(
    ctx: PortfolioMutationCtx,
    app: Doc<"strategies">["app"],
    rows: Array<Omit<Doc<"provider_working_orders">, "_id" | "_creationTime">>
): Promise<{ inserted: number; patched: number; deleted: number; unchanged: number }> {
    const existing = await ctx.db
        .query("provider_working_orders")
        .withIndex("by_app", (q) => q.eq("app", app))
        .collect()

    const existingByKey = new Map(existing.map((row) => [row.orderId, row]))
    const nextKeySet = new Set(rows.map((row) => row.orderId))
    const stats = {
        inserted: 0,
        patched: 0,
        deleted: 0,
        unchanged: 0,
    }

    for (const row of rows) {
        const current = existingByKey.get(row.orderId)
        if (!current) {
            await ctx.db.insert("provider_working_orders", row)
            stats.inserted++
            continue
        }

        const changed = (
            current.strategyId !== row.strategyId ||
            current.runId !== row.runId ||
            current.ownershipStatus !== row.ownershipStatus ||
            current.expectedExternal !== row.expectedExternal ||
            current.venue !== row.venue ||
            current.instrument !== row.instrument ||
            current.status !== row.status ||
            current.action !== row.action ||
            current.side !== row.side ||
            current.quantity !== row.quantity ||
            current.filledQuantity !== row.filledQuantity ||
            current.remainingQuantity !== row.remainingQuantity ||
            current.limitPrice !== row.limitPrice ||
            current.stopPrice !== row.stopPrice ||
            current.avgFillPrice !== row.avgFillPrice ||
            current.metadata !== row.metadata ||
            current.submittedAt !== row.submittedAt ||
            current.updatedAt !== row.updatedAt ||
            current.cancelAt !== row.cancelAt ||
            current.syncedAt !== row.syncedAt
        )

        if (!changed) {
            stats.unchanged++
            continue
        }

        await ctx.db.patch(current._id, {
            strategyId: row.strategyId,
            runId: row.runId,
            ownershipStatus: row.ownershipStatus,
            expectedExternal: row.expectedExternal,
            venue: row.venue,
            instrument: row.instrument,
            status: row.status,
            action: row.action,
            side: row.side,
            quantity: row.quantity,
            filledQuantity: row.filledQuantity,
            remainingQuantity: row.remainingQuantity,
            limitPrice: row.limitPrice,
            stopPrice: row.stopPrice,
            avgFillPrice: row.avgFillPrice,
            metadata: row.metadata,
            submittedAt: row.submittedAt,
            updatedAt: row.updatedAt,
            cancelAt: row.cancelAt,
            syncedAt: row.syncedAt,
        })
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

async function writeStrategyPositionSnapshots(
    ctx: PortfolioMutationCtx,
    args: {
        app: Doc<"strategies">["app"]
        strategies: StrategyDoc[]
        positions: Array<{
            strategyId?: Id<"strategies">
            positionKey?: string
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
): Promise<{
    decision: string
    stats: { written: number; skipped: number }
    hashInput: Array<{ strategyId: string; snapshotHash: string; written: boolean }>
}> {
    const positionsByStrategy = new Map<string, typeof args.positions>()
    const hashInput: Array<{ strategyId: string; snapshotHash: string; written: boolean }> = []
    let written = 0
    let skipped = 0

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
        const snapshotHash = computeHash(
            strategyPositions
                .map((position) => ({
                    instrument: position.instrument,
                    side: position.side,
                    quantity: position.quantity,
                    entryPrice: position.entryPrice,
                    currentPrice: position.currentPrice,
                    unrealizedPnl: position.unrealizedPnl,
                    metadata: position.metadata,
                }))
                .sort((left, right) =>
                    `${left.instrument}:${left.side}`.localeCompare(`${right.instrument}:${right.side}`)
                )
        )
        const latestSync = await ctx.db
            .query("position_syncs")
            .withIndex("by_strategy_synced_at", (q) => q.eq("strategyId", strategy._id))
            .order("desc")
            .first()

        const unchanged = latestSync?.snapshotHash === snapshotHash
        if (unchanged) {
            skipped++
            hashInput.push({
                strategyId: String(strategy._id),
                snapshotHash,
                written: false,
            })
            await replacePositionClaims(ctx, {
                strategyId: strategy._id,
                app: args.app,
                positionClaims: strategyPositions.map((position) => buildPositionClaim(position)),
                updatedAt: args.syncedAt,
            })
            continue
        }

        await ctx.db.insert("position_syncs", {
            strategyId: strategy._id,
            app: args.app,
            syncedAt: args.syncedAt,
            positionCount: strategyPositions.length,
            snapshotHash,
            decision: "written:position_state_changed",
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
            positionClaims: strategyPositions.map((position) => buildPositionClaim(position)),
            updatedAt: args.syncedAt,
        })

        written++
        hashInput.push({
            strategyId: String(strategy._id),
            snapshotHash,
            written: true,
        })
    }

    const decision = written > 0
        ? `written:${written};skipped:${skipped}`
        : `skipped_all:${skipped}`

    return {
        decision,
        stats: {
            written,
            skipped,
        },
        hashInput,
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
    ownershipMismatches: string[]
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

    if (args.ownershipMismatches.length > 0) {
        parts.push(`${args.ownershipMismatches.length} provider position ownership mismatch(es) were detected`)
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

function computeHash(value: unknown): string {
    const canonical = JSON.stringify(canonicalize(value))
    let hash = 0x811c9dc5

    for (let i = 0; i < canonical.length; i++) {
        hash ^= canonical.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
    }

    return (hash >>> 0).toString(16).padStart(8, "0")
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map((entry) => canonicalize(entry))
    }

    if (value && typeof value === "object") {
        const record = value as Record<string, unknown>
        const keys = Object.keys(record).sort((left, right) => left.localeCompare(right))
        const normalized: Record<string, unknown> = {}
        for (const key of keys) {
            normalized[key] = canonicalize(record[key])
        }
        return normalized
    }

    return value
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

function readOrderCancelAt(order: OrderDoc | undefined): number | undefined {
    if (!order || !order.intent || typeof order.intent !== "object") {
        return undefined
    }

    const metadata = (order.intent as Record<string, unknown>).metadata
    if (!metadata || typeof metadata !== "object") {
        return undefined
    }

    const cancelAt = (metadata as Record<string, unknown>).cancelAt
    return typeof cancelAt === "number" && Number.isFinite(cancelAt)
        ? cancelAt
        : undefined
}

export const portfolioGovernanceTestables = {
    collectExpectedExternalInstruments,
    isExpectedExternalProviderRow,
    buildAdoptedPositionClaims,
    buildPositionClaimsByKey,
    buildProviderPositionKey,
    createDriftSummary,
    hasPositionOwnershipMismatch,
    resolveProviderPositionId,
    resolvePositionOwnership,
    resolveOwnership,
    inferClosedOrderStatus,
    readOrderCancelAt,
}

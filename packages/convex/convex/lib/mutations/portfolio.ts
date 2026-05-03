import { mutation } from "../../_generated/server"
import type { MutationCtx } from "../../_generated/server"
import type { Doc, Id } from "../../_generated/dataModel"
import { v } from "convex/values"
import {
    isTerminalOrderStatus,
    getOrderIdentityCandidates,
    resolveProviderAdoptionInstruments,
} from "@valiq-trading/core"
import { requireServiceToken } from "../authGuards"
import {
    getClaimInstrumentsForOrder,
    getProviderInstrumentClaimAliases,
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
import { appendOrderTransition, upsertOrderRow } from "./orders"

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

const providerPositionClosureInputV = v.object({
    instrument: v.string(),
    providerPositionId: v.optional(v.string()),
    side: v.union(v.literal("long"), v.literal("short")),
    quantity: v.number(),
    fillPrice: v.number(),
    closedAt: v.number(),
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
        positionClosures: v.optional(v.array(providerPositionClosureInputV)),
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
        const activeOrdersById = buildActiveOrderLookup(activeOrders)
        const protectionLevelsByInstrument = buildProtectionLevels(args.workingOrders)
        const expectedExternalInstruments = collectExpectedExternalInstruments(strategies)
        const existingProviderPositions = await ctx.db
            .query("provider_positions")
            .withIndex("by_app", (q) => q.eq("app", args.app))
            .collect()
        const existingProviderPositionsByKey = new Map(
            existingProviderPositions.map((position) => [position.positionKey, position])
        )
        const providerPositionClosures = args.positionClosures ?? []

        const statusMismatches: string[] = []
        const closedPersistedOrders: string[] = []
        const matchedActiveOrderIds = new Set<string>()
        const matchedWorkingOrdersByLiveId = new Map<string, OrderDoc>()

        for (const liveOrder of args.workingOrders) {
            const existingOrder = resolveLiveWorkingOrderMatch({
                app: args.app,
                liveOrder,
                activeOrders,
                activeOrdersById,
                matchedActiveOrderIds,
            })
            if (!existingOrder) {
                continue
            }

            matchedActiveOrderIds.add(existingOrder.orderId)
            matchedWorkingOrdersByLiveId.set(liveOrder.orderId, existingOrder)

            if (
                existingOrder.status !== liveOrder.status ||
                existingOrder.filledQuantity !== liveOrder.filledQuantity ||
                existingOrder.remainingQuantity !== liveOrder.remainingQuantity
            ) {
                statusMismatches.push(liveOrder.orderId)
            }

            await applyProviderWorkingOrderUpdate(ctx, {
                order: existingOrder,
                liveOrder,
                updatedAt: now,
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
            liveInstrumentAliases: buildLiveInstrumentAliases(
                args.app,
                [
                    ...args.positions.map((position) => position.instrument),
                    ...args.workingOrders.map((order) => order.instrument),
                ]
            ),
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
                app: args.app,
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

        const latestRunIdsByStrategy = new Map<string, Id<"strategy_runs"> | undefined>()
        const resolvedWorkingOrders = []

        for (const order of args.workingOrders) {
            const existingOrder = matchedWorkingOrdersByLiveId.get(order.orderId)
            const ownership = resolveOwnership({
                app: args.app,
                instrument: order.instrument,
                claimsByInstrument: refreshedClaimsByInstrument,
                existingOrder,
                strategyMap,
            })
            const importedProtectionOrder = existingOrder === undefined
                ? await importCanonicalProviderProtectionOrder(ctx, {
                    app: args.app,
                    venue: args.venue,
                    order,
                    ownership,
                    strategyMap,
                    latestRunIdsByStrategy,
                    updatedAt: now,
                })
                : undefined
            const expectedExternal = ownership.ownershipStatus !== "owned" && isExpectedExternalProviderRow(
                expectedExternalInstruments,
                order
            )

            resolvedWorkingOrders.push({
                ...order,
                venue: existingOrder?.venue ?? importedProtectionOrder?.venue ?? args.venue,
                action: existingOrder?.action ?? importedProtectionOrder?.action,
                runId: existingOrder?.runId ?? importedProtectionOrder?.runId,
                cancelAt: order.cancelAt ?? readOrderCancelAt(existingOrder),
                canonicalTracked: existingOrder !== undefined || importedProtectionOrder !== undefined,
                expectedExternal,
                ...ownership,
            })
        }

        const unresolvedOwnedWorkingOrders = resolvedWorkingOrders.filter((order) =>
            order.ownershipStatus === "owned" &&
            order.expectedExternal !== true &&
            order.canonicalTracked !== true
        )
        const exposureViolations = detectExposureGovernanceViolations({
            strategies,
            positions: resolvedPositions,
            workingOrders: resolvedWorkingOrders,
        })

        for (const existingOrder of activeOrders) {
            if (matchedActiveOrderIds.has(existingOrder.orderId)) {
                continue
            }

            if (hasUnresolvedLiveWorkingOrderGap(existingOrder, unresolvedOwnedWorkingOrders)) {
                continue
            }

            const inferredResolution = inferClosedOrderStatus({
                app: args.app,
                order: existingOrder,
                livePositions: args.positions,
            })
            closedPersistedOrders.push(existingOrder.orderId)

            await applyClosedOrderInference(ctx, {
                order: existingOrder,
                inferredResolution,
                updatedAt: now,
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

        await reconcileProviderPositionClosures(ctx, {
            app: args.app,
            strategyMap,
            existingProviderPositions,
            livePositionKeys: new Set(nextProviderPositions.map((position) => position.positionKey)),
            positionClosures: providerPositionClosures,
            updatedAt: now,
        })

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
        await resolveExecutionSafetyFaultsFromProviderTruth(ctx, {
            app: args.app,
            positions: nextProviderPositions,
            workingOrders: nextProviderWorkingOrders,
            updatedAt: now,
        })

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
            untrackedOwnedOrderCount: unresolvedOwnedWorkingOrders.length,
            closedPersistedOrders,
            statusMismatches,
            ownershipMismatches: Array.from(ownershipMismatches),
            exposureViolations,
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

function buildLiveInstrumentAliases(
    app: Doc<"strategies">["app"],
    instruments: string[]
): Map<string, Set<string>> {
    const aliases = new Map<string, Set<string>>()

    for (const instrument of instruments) {
        aliases.set(instrument, new Set(getProviderInstrumentClaimAliases(app, instrument)))
    }

    return aliases
}

function setsIntersect(left: Set<string>, right: Set<string>): boolean {
    for (const value of left) {
        if (right.has(value)) {
            return true
        }
    }

    return false
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
        liveInstrumentAliases: Map<string, Set<string>>
        updatedAt: number
    }
): Promise<void> {
    if (args.liveInstrumentAliases.size === 0) {
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

        const orderAliases = new Set(getClaimInstrumentsForOrder(order.instrument, order.intent))
        for (const [liveInstrument, liveAliases] of args.liveInstrumentAliases) {
            if (claimedInstruments.has(liveInstrument) || !setsIntersect(orderAliases, liveAliases)) {
                continue
            }

            const strategies = candidateStrategiesByInstrument.get(liveInstrument) ?? new Set<Id<"strategies">>()
            strategies.add(order.strategyId)
            candidateStrategiesByInstrument.set(liveInstrument, strategies)
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

async function reconcileProviderPositionClosures(
    ctx: PortfolioMutationCtx,
    args: {
        app: Doc<"strategies">["app"]
        strategyMap: Map<string, StrategyDoc>
        existingProviderPositions: Doc<"provider_positions">[]
        livePositionKeys: Set<string>
        positionClosures: Array<{
            instrument: string
            providerPositionId?: string
            side: "long" | "short"
            quantity: number
            fillPrice: number
            closedAt: number
            metadata?: string
        }>
        updatedAt: number
    }
): Promise<void> {
    if (args.positionClosures.length === 0) {
        return
    }

    const candidatePositions = args.existingProviderPositions.filter((position) =>
        position.ownershipStatus === "owned" &&
        position.strategyId !== undefined &&
        position.expectedExternal !== true &&
        !args.livePositionKeys.has(position.positionKey)
    )
    const latestRunIdsByStrategy = new Map<string, Id<"strategy_runs"> | undefined>()

    for (const position of candidatePositions) {
        const strategy = position.strategyId
            ? args.strategyMap.get(String(position.strategyId))
            : undefined
        if (!strategy || !position.strategyId) {
            continue
        }

        const strategyKey = String(position.strategyId)
        const runId = latestRunIdsByStrategy.has(strategyKey)
            ? latestRunIdsByStrategy.get(strategyKey)
            : await resolveLatestRunIdForStrategy(ctx, position.strategyId)
        latestRunIdsByStrategy.set(strategyKey, runId)
        if (!runId) {
            continue
        }

        const closure = resolveMatchingPositionClosure(position, args.positionClosures)
        if (!closure) {
            continue
        }

        const syntheticOrderId = buildProviderCloseOrderId(args.app, position, closure)
        const existingOrder = await ctx.db
            .query("orders")
            .withIndex("by_order_id", (q) => q.eq("orderId", syntheticOrderId))
            .first()

        await upsertOrderRow(ctx, {
            orderId: syntheticOrderId,
            providerOrderId: resolveProviderCloseOrderProviderId(closure) ?? syntheticOrderId,
            providerOrderAliases: [],
            runId: existingOrder?.runId ?? runId,
            strategyId: position.strategyId,
            venue: args.app,
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

        if ((existingOrder?.lastTransitionSequence ?? 0) === 0) {
            await appendOrderTransition(ctx, {
                orderId: syntheticOrderId,
                runId: existingOrder?.runId ?? runId,
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
                runId: existingOrder?.runId ?? runId,
                strategyId: position.strategyId,
                app: args.app,
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
    }
}

function resolveMatchingPositionClosure(
    position: Doc<"provider_positions">,
    closures: Array<{
        instrument: string
        providerPositionId?: string
        side: "long" | "short"
        quantity: number
        fillPrice: number
        closedAt: number
        metadata?: string
    }>
) {
    const candidates = closures.filter((closure) =>
        closure.instrument === position.instrument &&
        closure.side === position.side &&
        closure.closedAt >= position.syncedAt
    )

    if (candidates.length === 0) {
        return undefined
    }

    const positionIds = buildProviderPositionIdentityCandidates(position)
    const strongMatches = candidates.filter((closure) =>
        closure.providerPositionId !== undefined &&
        positionIds.has(closure.providerPositionId)
    )
    if (strongMatches.length > 0) {
        return strongMatches.sort((left, right) => right.closedAt - left.closedAt)[0]
    }

    const quantityMatches = candidates.filter((closure) => almostEqual(closure.quantity, position.quantity))
    if (quantityMatches.length === 1) {
        return quantityMatches[0]
    }

    if (candidates.length === 1) {
        return candidates[0]
    }

    return candidates.sort((left, right) => right.closedAt - left.closedAt)[0]
}

function buildProviderPositionIdentityCandidates(
    position: Pick<Doc<"provider_positions">, "providerPositionId" | "metadata">
): Set<string> {
    const identifiers = new Set<string>()
    if (position.providerPositionId) {
        identifiers.add(position.providerPositionId)
    }

    const metadata = readMetadataRecord(position.metadata)
    addKnownIdentifier(identifiers, metadata?.ticket)
    addKnownIdentifier(identifiers, metadata?.identifier)
    addKnownIdentifier(identifiers, metadata?.positionId)
    addKnownIdentifier(identifiers, metadata?.providerPositionId)
    return identifiers
}

function addKnownIdentifier(
    identifiers: Set<string>,
    value: unknown
): void {
    if (typeof value === "string" && value.trim().length > 0) {
        identifiers.add(value.trim())
        return
    }

    if (typeof value === "number" && Number.isFinite(value)) {
        identifiers.add(String(value))
    }
}

function buildProviderCloseOrderId(
    app: Doc<"strategies">["app"],
    position: Pick<Doc<"provider_positions">, "positionKey">,
    closure: { closedAt: number }
): string {
    return `provider-close:${app}:${position.positionKey}:${closure.closedAt}`
}

function resolveProviderCloseOrderProviderId(
    closure: { metadata?: string }
): string | undefined {
    const metadata = parseJson<Record<string, unknown>>(closure.metadata)
    const orderId = metadata?.orderId
    if (typeof orderId === "string" && orderId.trim().length > 0) {
        return orderId.trim()
    }

    if (typeof orderId === "number" && Number.isFinite(orderId)) {
        return String(orderId)
    }

    return undefined
}

function buildProviderCloseIntent(
    position: Pick<
        Doc<"provider_positions">,
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

function almostEqual(left: number, right: number): boolean {
    return Math.abs(left - right) <= 0.000001
}

async function resolveLatestRunIdForStrategy(
    ctx: PortfolioMutationCtx,
    strategyId: Id<"strategies">
): Promise<Id<"strategy_runs"> | undefined> {
    const runs = await ctx.db
        .query("strategy_runs")
        .withIndex("by_strategy", (q) => q.eq("strategyId", strategyId))
        .collect()

    return runs
        .sort((left, right) => right.startedAt - left.startedAt)[0]?._id
}

function buildActiveOrderLookup(activeOrders: OrderDoc[]): Map<string, OrderDoc> {
    const lookup = new Map<string, OrderDoc>()

    for (const order of activeOrders) {
        for (const orderId of getOrderIdentityCandidates(order)) {
            lookup.set(orderId, order)
        }
    }

    return lookup
}

async function importCanonicalProviderProtectionOrder(
    ctx: PortfolioMutationCtx,
    args: {
        app: Doc<"strategies">["app"]
        venue: string
        order: {
            orderId: string
            instrument: string
            status: Doc<"orders">["status"]
            quantity: number
            filledQuantity: number
            remainingQuantity: number
            submittedAt: number
            updatedAt: number
            side?: "buy" | "sell"
            limitPrice?: number
            stopPrice?: number
            avgFillPrice?: number
            metadata?: string
        }
        ownership: ResolvedOwnership
        strategyMap: Map<string, StrategyDoc>
        latestRunIdsByStrategy: Map<string, Id<"strategy_runs"> | undefined>
        updatedAt: number
    }
): Promise<{ runId: Id<"strategy_runs">; action: Doc<"orders">["action"]; venue: string } | undefined> {
    if (args.app !== "okx-swap" || args.ownership.ownershipStatus !== "owned" || !args.ownership.strategyId) {
        return undefined
    }

    const metadata = readMetadataRecord(args.order.metadata)
    if (metadata?.kind !== "protection") {
        return undefined
    }

    const strategy = args.strategyMap.get(String(args.ownership.strategyId))
    if (!strategy) {
        return undefined
    }

    const existingOrder = await ctx.db
        .query("orders")
        .withIndex("by_order_id", (q) => q.eq("orderId", args.order.orderId))
        .first()
    if (existingOrder) {
        return {
            runId: existingOrder.runId,
            action: existingOrder.action,
            venue: existingOrder.venue,
        }
    }

    const strategyKey = String(args.ownership.strategyId)
    const runId = args.latestRunIdsByStrategy.has(strategyKey)
        ? args.latestRunIdsByStrategy.get(strategyKey)
        : await resolveLatestRunIdForStrategy(ctx, args.ownership.strategyId)
    args.latestRunIdsByStrategy.set(strategyKey, runId)
    if (!runId) {
        return undefined
    }

    const intent = buildProviderProtectionIntent(args.order, metadata)
    await upsertOrderRow(ctx, {
        orderId: args.order.orderId,
        providerOrderId: args.order.orderId,
        providerOrderAliases: [],
        runId,
        strategyId: args.ownership.strategyId,
        venue: args.venue,
        instrument: args.order.instrument,
        status: args.order.status,
        action: "close",
        quantity: args.order.quantity,
        filledQuantity: args.order.filledQuantity,
        remainingQuantity: args.order.remainingQuantity,
        avgFillPrice: args.order.avgFillPrice,
        submittedAt: args.order.submittedAt,
        updatedAt: args.order.updatedAt,
        intent,
        metadata: {
            providerImportedWorkingOrder: true,
            providerOrderKind: "protection",
            providerMetadata: metadata,
        },
        lastTransitionSequence: 0,
        polling: {
            pollIntervalMs: 5_000,
            timeoutMs: 120_000,
            startedAt: args.order.submittedAt,
            lastCheckedAt: args.updatedAt,
            nextCheckAt: args.updatedAt + 5_000,
        },
    })

    await appendOrderTransition(ctx, {
        orderId: args.order.orderId,
        runId,
        strategyId: args.ownership.strategyId,
        type: "submission",
        status: args.order.status,
        reason: "Provider reconciliation imported a live OKX protection algo order as canonical working-order state",
        details: {
            providerOrderId: args.order.orderId,
            providerMetadata: metadata,
        },
        timestamp: args.order.submittedAt,
    })

    await ctx.db.insert("trade_events", {
        runId,
        strategyId: args.ownership.strategyId,
        app: args.app,
        eventType: "submission",
        payload: JSON.stringify({
            providerImportedWorkingOrder: true,
            result: {
                orderId: args.order.orderId,
                status: args.order.status,
                filledQuantity: args.order.filledQuantity,
                fillPrice: args.order.avgFillPrice,
                timestamp: args.order.updatedAt,
            },
            intent,
        }),
        timestamp: args.order.submittedAt,
    })

    return {
        runId,
        action: "close",
        venue: args.venue,
    }
}

function buildProviderProtectionIntent(
    order: {
        instrument: string
        side?: "buy" | "sell"
        quantity: number
        limitPrice?: number
        stopPrice?: number
    },
    metadata: Record<string, unknown> | undefined
): Record<string, unknown> {
    return {
        instrument: order.instrument,
        side: order.side ?? "sell",
        quantity: order.quantity,
        orderType: resolveProviderProtectionOrderType(order),
        limitPrice: order.limitPrice,
        stopPrice: order.stopPrice,
        timeInForce: "gtc",
        metadata: {
            action: "close",
            providerProtectionOrder: true,
            protectionOrderType: metadata?.orderType,
            stopLoss: order.stopPrice,
            takeProfit: order.limitPrice,
            providerMetadata: metadata,
        },
    }
}

function resolveProviderProtectionOrderType(order: {
    limitPrice?: number
    stopPrice?: number
}): "limit" | "stop" | "stop_limit" {
    if (order.limitPrice !== undefined && order.stopPrice !== undefined) {
        return "stop_limit"
    }

    return order.stopPrice !== undefined ? "stop" : "limit"
}

function resolveLiveWorkingOrderMatch(args: {
    app: Doc<"strategies">["app"]
    liveOrder: {
        orderId: string
        instrument: string
        status: Doc<"orders">["status"]
        quantity: number
        filledQuantity: number
        remainingQuantity: number
        side?: "buy" | "sell"
        limitPrice?: number
        stopPrice?: number
        metadata?: string
    }
    activeOrders: OrderDoc[]
    activeOrdersById: Map<string, OrderDoc>
    matchedActiveOrderIds: Set<string>
}): OrderDoc | undefined {
    const directMatch = args.activeOrdersById.get(args.liveOrder.orderId)
    if (directMatch && !args.matchedActiveOrderIds.has(directMatch.orderId)) {
        return directMatch
    }

    if (args.app !== "mt5") {
        return undefined
    }

    const candidates = args.activeOrders.filter((order) =>
        !args.matchedActiveOrderIds.has(order.orderId) &&
        matchesMT5WorkingOrderContinuity(order, args.liveOrder)
    )

    return candidates.length === 1 ? candidates[0] : undefined
}

function hasUnresolvedLiveWorkingOrderGap(
    order: OrderDoc,
    unresolvedWorkingOrders: Array<{
        instrument: string
        quantity: number
        remainingQuantity: number
        side?: "buy" | "sell"
        limitPrice?: number
        stopPrice?: number
        metadata?: string
    }>
): boolean {
    return unresolvedWorkingOrders.some((liveOrder) => matchesMT5WorkingOrderContinuity(order, liveOrder))
}

function matchesMT5WorkingOrderContinuity(
    order: Pick<
        OrderDoc,
        "orderId" |
        "providerOrderId" |
        "providerOrderAliases" |
        "venue" |
        "instrument" |
        "status" |
        "action" |
        "quantity" |
        "filledQuantity" |
        "remainingQuantity" |
        "intent"
    >,
    liveOrder: {
        instrument: string
        quantity: number
        remainingQuantity: number
        side?: "buy" | "sell"
        limitPrice?: number
        stopPrice?: number
        metadata?: string
    }
): boolean {
    if (order.venue !== "mt5") {
        return false
    }

    if (order.action !== "entry" && order.action !== "adjustment") {
        return false
    }

    if (order.instrument !== liveOrder.instrument) {
        return false
    }

    const intent = readOrderIntentRecord(order.intent)
    const intentMetadata = readOrderIntentRecord(intent?.metadata)
    const intentSide = intent?.side === "buy" || intent?.side === "sell"
        ? intent.side
        : undefined
    const intentLimitPrice = readFiniteNumber(intent?.limitPrice)
    const intentStopLoss = readFiniteNumber(intentMetadata?.stopLoss)
    const intentTakeProfit = readFiniteNumber(intentMetadata?.takeProfit)
    const liveMetadata = readMetadataRecord(liveOrder.metadata)
    const liveTakeProfit = readFiniteNumber(liveMetadata?.takeProfit)

    if (liveOrder.side && intentSide !== liveOrder.side) {
        return false
    }

    if (!almostEqual(order.quantity, liveOrder.quantity)) {
        return false
    }

    if (!almostEqual(order.remainingQuantity, liveOrder.remainingQuantity)) {
        return false
    }

    if (liveOrder.limitPrice !== undefined && intentLimitPrice !== undefined && !almostEqual(intentLimitPrice, liveOrder.limitPrice)) {
        return false
    }

    if (liveOrder.stopPrice !== undefined && intentStopLoss !== undefined && !almostEqual(intentStopLoss, liveOrder.stopPrice)) {
        return false
    }

    if (liveTakeProfit !== undefined && intentTakeProfit !== undefined && !almostEqual(intentTakeProfit, liveTakeProfit)) {
        return false
    }

    return true
}

function readOrderIntentRecord(intent: unknown): Record<string, unknown> | undefined {
    return intent && typeof intent === "object"
        ? intent as Record<string, unknown>
        : undefined
}

function readFiniteNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value)
        ? value
        : undefined
}

async function applyProviderWorkingOrderUpdate(
    ctx: PortfolioMutationCtx,
    args: {
        order: OrderDoc
        liveOrder: {
            orderId: string
            status: Doc<"orders">["status"]
            filledQuantity: number
            remainingQuantity: number
            avgFillPrice?: number
            updatedAt: number
        }
        updatedAt: number
    }
): Promise<void> {
    const order = args.order
    const liveOrder = args.liveOrder
    const nextProviderOrderAliases = mergeProviderOrderAliases(order, liveOrder.orderId)
    const nextStatus = liveOrder.status
    const nextFilledQuantity = liveOrder.filledQuantity
    const nextRemainingQuantity = liveOrder.remainingQuantity
    const nextAvgFillPrice = liveOrder.avgFillPrice ?? order.avgFillPrice
    const statusChanged = order.status !== nextStatus
    const quantityChanged =
        order.filledQuantity !== nextFilledQuantity ||
        order.remainingQuantity !== nextRemainingQuantity ||
        order.avgFillPrice !== nextAvgFillPrice
    const currentProviderOrderId = order.providerOrderId ?? order.orderId
    const providerOrderIdChanged = currentProviderOrderId !== liveOrder.orderId

    await upsertOrderRow(ctx, {
        orderId: order.orderId,
        providerOrderId: liveOrder.orderId,
        providerOrderAliases: nextProviderOrderAliases,
        runId: order.runId,
        strategyId: order.strategyId,
        venue: order.venue,
        instrument: order.instrument,
        status: nextStatus,
        action: order.action,
        quantity: order.quantity,
        filledQuantity: nextFilledQuantity,
        remainingQuantity: nextRemainingQuantity,
        avgFillPrice: nextAvgFillPrice,
        submittedAt: order.submittedAt,
        updatedAt: liveOrder.updatedAt,
        intent: order.intent,
        metadata: order.metadata,
        lastTransitionSequence: order.lastTransitionSequence,
        polling: {
            ...order.polling,
            lastCheckedAt: args.updatedAt,
            nextCheckAt: isTerminalOrderStatus(nextStatus)
                ? undefined
                : args.updatedAt + order.polling.pollIntervalMs,
            lastError: undefined,
        },
    })

    if (!statusChanged && !quantityChanged && !providerOrderIdChanged) {
        return
    }

    await appendOrderTransition(ctx, {
        orderId: order.orderId,
        runId: order.runId,
        strategyId: order.strategyId,
        type: isTerminalOrderStatus(nextStatus) ? "terminal" : "status_change",
        status: nextStatus,
        previousStatus: order.status,
        reason: "Provider reconciliation refreshed the live working-order state",
        details: {
            providerOrderId: liveOrder.orderId,
            previousProviderOrderId: currentProviderOrderId,
            filledQuantity: nextFilledQuantity,
            remainingQuantity: nextRemainingQuantity,
            avgFillPrice: nextAvgFillPrice,
        },
        timestamp: liveOrder.updatedAt,
    })
}

async function applyClosedOrderInference(
    ctx: PortfolioMutationCtx,
    args: {
        order: OrderDoc
        inferredResolution: {
            status: Doc<"orders">["status"]
            filledQuantity?: number
            remainingQuantity?: number
            avgFillPrice?: number
        }
        updatedAt: number
    }
): Promise<void> {
    const order = args.order
    const nextStatus = args.inferredResolution.status
    const nextFilledQuantity = args.inferredResolution.filledQuantity ?? order.filledQuantity
    const nextRemainingQuantity = args.inferredResolution.remainingQuantity ?? order.remainingQuantity
    const nextAvgFillPrice = args.inferredResolution.avgFillPrice ?? order.avgFillPrice
    const resolutionReason = nextStatus === "filled"
        ? "Provider reconciliation inferred a fill from provider-truth position state after the order left the live working-order book"
        : "Provider reconciliation inferred a cancellation after the order left the live working-order book without fill evidence"

    await upsertOrderRow(ctx, {
        orderId: order.orderId,
        providerOrderId: order.providerOrderId ?? order.orderId,
        providerOrderAliases: order.providerOrderAliases ?? [],
        runId: order.runId,
        strategyId: order.strategyId,
        venue: order.venue,
        instrument: order.instrument,
        status: nextStatus,
        action: order.action,
        quantity: order.quantity,
        filledQuantity: nextFilledQuantity,
        remainingQuantity: nextRemainingQuantity,
        avgFillPrice: nextAvgFillPrice,
        submittedAt: order.submittedAt,
        updatedAt: args.updatedAt,
        intent: order.intent,
        metadata: order.metadata,
        lastTransitionSequence: order.lastTransitionSequence,
        polling: {
            ...order.polling,
            lastCheckedAt: args.updatedAt,
            nextCheckAt: undefined,
            timedOutAt: undefined,
            lastError: nextStatus === "cancelled"
                ? resolutionReason
                : undefined,
        },
    })

    await appendOrderTransition(ctx, {
        orderId: order.orderId,
        runId: order.runId,
        strategyId: order.strategyId,
        type: "terminal",
        status: nextStatus,
        previousStatus: order.status,
        reason: resolutionReason,
        details: {
            providerOrderId: order.providerOrderId ?? order.orderId,
            filledQuantity: nextFilledQuantity,
            remainingQuantity: nextRemainingQuantity,
            avgFillPrice: nextAvgFillPrice,
        },
        timestamp: args.updatedAt,
    })
}

function mergeProviderOrderAliases(
    order: Pick<OrderDoc, "orderId" | "providerOrderId" | "providerOrderAliases">,
    nextProviderOrderId: string
): string[] {
    const aliases = new Set<string>(order.providerOrderAliases ?? [])

    if (
        (order.providerOrderId ?? order.orderId) !== order.orderId &&
        (order.providerOrderId ?? order.orderId) !== nextProviderOrderId
    ) {
        aliases.add(order.providerOrderId ?? order.orderId)
    }

    aliases.delete(order.orderId)
    aliases.delete(nextProviderOrderId)

    return Array.from(aliases).sort((left, right) => left.localeCompare(right))
}

function detectExposureGovernanceViolations(args: {
    strategies: StrategyDoc[]
    positions: Array<{
        strategyId?: Id<"strategies">
        ownershipStatus: Doc<"provider_positions">["ownershipStatus"]
        expectedExternal?: boolean
        instrument: string
        side: "long" | "short"
    }>
    workingOrders: Array<{
        strategyId?: Id<"strategies">
        ownershipStatus: Doc<"provider_working_orders">["ownershipStatus"]
        expectedExternal?: boolean
        instrument: string
        action?: Doc<"orders">["action"]
        side?: "buy" | "sell"
    }>
}): string[] {
    const strategyPolicies = new Map(
        args.strategies.map((strategy) => [String(strategy._id), readStrategyExposurePolicy(strategy)])
    )
    const violations = new Set<string>()

    const ownedPositions = args.positions.filter((position) =>
        position.strategyId !== undefined &&
        position.ownershipStatus === "owned" &&
        position.expectedExternal !== true
    )
    const ownedWorkingOrders = args.workingOrders.filter((order) =>
        order.strategyId !== undefined &&
        order.ownershipStatus === "owned" &&
        order.expectedExternal !== true
    )

    const strategyIds = new Set([
        ...ownedPositions.map((position) => String(position.strategyId)),
        ...ownedWorkingOrders.map((order) => String(order.strategyId)),
    ])

    for (const strategyId of strategyIds) {
        const policy = strategyPolicies.get(strategyId)
        if (!policy) {
            continue
        }

        const strategyPositions = ownedPositions.filter((position) => String(position.strategyId) === strategyId)
        const strategyWorkingOrders = ownedWorkingOrders.filter((order) => String(order.strategyId) === strategyId)

        if (!policy.allowOverlappingExposure) {
            for (const position of strategyPositions) {
                const sameInstrumentOrders = strategyWorkingOrders.filter((order) =>
                    order.instrument === position.instrument &&
                    workingOrderIncreasesExposure(order, position.side)
                )

                if (sameInstrumentOrders.length > 0) {
                    violations.add(`${strategyId}:overlap:${position.instrument}`)
                }
            }
        }

        if (!policy.allowMultiplePendingEntryOrdersPerInstrument) {
            const grouped = new Map<string, number>()
            for (const order of strategyWorkingOrders) {
                if (!workingOrderCanOpenRisk(order)) {
                    continue
                }

                const direction = order.side ?? "unknown"
                const key = `${order.instrument}:${direction}`
                grouped.set(key, (grouped.get(key) ?? 0) + 1)
            }

            for (const [key, count] of grouped) {
                if (count > 1) {
                    violations.add(`${strategyId}:multiple-working-orders:${key}`)
                }
            }
        }
    }

    return Array.from(violations).sort((left, right) => left.localeCompare(right))
}

function readStrategyExposurePolicy(strategy: StrategyDoc): {
    allowMultiplePendingEntryOrdersPerInstrument: boolean
    allowOverlappingExposure: boolean
} {
    const policy = strategy.policy && typeof strategy.policy === "object"
        ? strategy.policy as Record<string, unknown>
        : {}

    return {
        allowMultiplePendingEntryOrdersPerInstrument: policy.allowMultiplePendingEntryOrdersPerInstrument === true,
        allowOverlappingExposure: policy.allowOverlappingExposure === true,
    }
}

function workingOrderCanOpenRisk(order: {
    action?: Doc<"orders">["action"]
    side?: "buy" | "sell"
}): boolean {
    if (order.action === "close" || order.action === "cancel" || order.action === "modify") {
        return false
    }

    return order.side === "buy" || order.side === "sell"
}

function workingOrderIncreasesExposure(
    order: {
        action?: Doc<"orders">["action"]
        side?: "buy" | "sell"
    },
    positionSide: "long" | "short"
): boolean {
    if (!workingOrderCanOpenRisk(order)) {
        return false
    }

    return positionSide === "long"
        ? order.side === "buy"
        : order.side === "sell"
}

async function updateProviderSyncStateFromCurrentRows(
    ctx: PortfolioMutationCtx,
    app: Doc<"strategies">["app"],
    now: number
): Promise<void> {
    const [state, positions, orders, strategies] = await Promise.all([
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
        ctx.db
            .query("strategies")
            .withIndex("by_app", (q) => q.eq("app", app))
            .collect(),
    ])

    if (!state) {
        return
    }

    const activeOrders = await listActiveOrdersForApp(ctx, strategies)

    const unownedPositionCount = positions.filter((position) =>
        position.ownershipStatus !== "owned" && position.expectedExternal !== true
    ).length
    const unownedOrderCount = orders.filter((order) =>
        order.ownershipStatus !== "owned" && order.expectedExternal !== true
    ).length
    const activeOrdersById = buildActiveOrderLookup(activeOrders)
    const untrackedOwnedOrderCount = orders.filter((order) =>
        order.ownershipStatus === "owned" &&
        order.expectedExternal !== true &&
        !activeOrdersById.has(order.orderId)
    ).length
    const exposureViolations = detectExposureGovernanceViolations({
        strategies,
        positions,
        workingOrders: orders.map((order) => ({
            ...order,
            canonicalTracked: activeOrdersById.has(order.orderId),
        })),
    })
    const driftSummary = createDriftSummary({
        unownedPositionCount,
        unownedOrderCount,
        untrackedOwnedOrderCount,
        closedPersistedOrders: [],
        statusMismatches: [],
        ownershipMismatches: [],
        exposureViolations,
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
    app: Doc<"strategies">["app"]
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

    const claims = collectClaimsForAliases(
        args.claimsByInstrument,
        getProviderInstrumentClaimAliases(args.app, args.instrument)
    )
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

function collectClaimsForAliases(
    claimsByInstrument: Map<string, Set<Id<"strategies">>>,
    aliases: string[]
): Set<Id<"strategies">> | undefined {
    const claims = new Set<Id<"strategies">>()

    for (const alias of aliases) {
        const aliasClaims = claimsByInstrument.get(alias)
        if (!aliasClaims) {
            continue
        }

        for (const strategyId of aliasClaims) {
            claims.add(strategyId)
        }
    }

    return claims.size > 0 ? claims : undefined
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
        providerPositionId?: string
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

    if (isEntryLikeOrder(order)) {
        const orderAliases = new Set(getClaimInstrumentsForOrder(order.instrument, order.intent))
        const matchingPositions = args.livePositions.filter((position) =>
            entryOrderMatchesLivePositionInstrument(args.app, orderAliases, position.instrument) &&
            positionMatchesOrderDirection(order, position.side)
        )
        if (matchingPositions.length === 1) {
            const [matchingPosition] = matchingPositions
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
    }

    if (order.action === "close" && !hasMatchingLivePositionForClose(order, args.livePositions)) {
        return {
            status: "filled",
            filledQuantity: order.quantity,
            remainingQuantity: 0,
            avgFillPrice: order.avgFillPrice,
        }
    }

    return {
        status: "cancelled",
    }
}

function entryOrderMatchesLivePositionInstrument(
    app: Doc<"strategies">["app"],
    orderAliases: Set<string>,
    liveInstrument: string
): boolean {
    const liveAliases = getProviderInstrumentClaimAliases(app, liveInstrument)
    return liveAliases.some((alias) => orderAliases.has(alias))
}

function mt5PositionMatchesOrderDirection(order: OrderDoc, side: "long" | "short"): boolean {
    return positionMatchesOrderDirection(order, side)
}

function positionMatchesOrderDirection(order: OrderDoc, side: "long" | "short"): boolean {
    if (order.intent.side === "buy") {
        return side === "long"
    }
    if (order.intent.side === "sell") {
        return side === "short"
    }
    return true
}

function hasMatchingLivePositionForClose(
    order: OrderDoc,
    livePositions: Array<{
        instrument: string
        side: "long" | "short"
    }>
): boolean {
    const rawMetadata = order.intent?.metadata
    const metadata = rawMetadata && typeof rawMetadata === "object"
        ? rawMetadata as Record<string, unknown>
        : undefined
    const expectedPositionSide = metadata?.positionSide === "short"
        ? "short"
        : "long"

    return livePositions.some((position) =>
        position.instrument === order.instrument &&
        position.side === expectedPositionSide
    )
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

async function resolveExecutionSafetyFaultsFromProviderTruth(
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
    untrackedOwnedOrderCount: number
    closedPersistedOrders: string[]
    statusMismatches: string[]
    ownershipMismatches: string[]
    exposureViolations: string[]
}): string | undefined {
    const parts: string[] = []

    if (args.unownedPositionCount > 0) {
        parts.push(`${args.unownedPositionCount} live position(s) lack a clean strategy owner`)
    }

    if (args.unownedOrderCount > 0) {
        parts.push(`${args.unownedOrderCount} live working order(s) lack a clean strategy owner`)
    }

    if (args.untrackedOwnedOrderCount > 0) {
        parts.push(`${args.untrackedOwnedOrderCount} owned live working order(s) were not matched to a canonical active order`)
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

    if (args.exposureViolations.length > 0) {
        parts.push(`${args.exposureViolations.length} provider exposure governance violation(s) were detected`)
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
        limitPrice?: number
        stopPrice?: number
        metadata?: string
    }>
): Map<string, { stopLoss?: number; takeProfit?: number }> {
    const levels = new Map<string, { stopLoss?: number; takeProfit?: number }>()

    for (const order of orders) {
        const metadata = parseJson<Record<string, unknown>>(order.metadata)
        const orderType = typeof metadata?.type === "string"
            ? metadata.type
            : typeof metadata?.orderType === "string"
                ? metadata.orderType
                : undefined
        const current = levels.get(order.instrument) ?? {}

        if (metadata?.kind === "protection") {
            if (order.stopPrice !== undefined) {
                current.stopLoss = order.stopPrice
            }
            if (order.limitPrice !== undefined) {
                current.takeProfit = order.limitPrice
            }
        } else if (orderType === "STOP_MARKET" || orderType === "STOP") {
            current.stopLoss = order.stopPrice
        } else if (orderType === "TAKE_PROFIT_MARKET" || orderType === "TAKE_PROFIT") {
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
    detectExposureGovernanceViolations,
    hasPositionOwnershipMismatch,
    resolveProviderPositionId,
    resolvePositionOwnership,
    resolveOwnership,
    resolveLiveWorkingOrderMatch,
    buildProviderCloseIntent,
    buildProviderProtectionIntent,
    inferClosedOrderStatus,
    readOrderCancelAt,
}

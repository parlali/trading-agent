import { mutation } from "../../_generated/server"
import type { Doc, Id } from "../../_generated/dataModel"
import { v } from "convex/values"
import {
    resolveProviderAdoptionInstruments,
} from "@valiq-trading/core"
import { requireServiceToken } from "../authGuards"
import {
    getClaimInstrumentsForOrder,
    reconcileOrderInstrumentClaim,
    replacePositionClaims,
} from "../instrumentClaims"
import {
    buildProviderPositionKey,
} from "../providerPositions"
import {
    orderStatusV,
    venueAppV,
} from "../validators"
import { incrementControlPlaneMetric } from "../controlPlaneMetrics"
import {
    buildAdoptedPositionClaims,
    buildClaimsByInstrument,
    buildPositionClaimsByKey,
    hasPositionOwnershipMismatch,
    repairMissingLivePositionClaimsFromFilledOrders,
    resolveOwnership,
} from "./portfolioOwnership"
import {
    applyClosedOrderInference,
    applyProviderWorkingOrderUpdate,
    buildActiveOrderLookup,
    hasUnresolvedLiveWorkingOrderGap,
    importCanonicalProviderProtectionOrder,
    inferClosedOrderStatus,
    listActiveOrdersForApp,
    reconcileProviderPositionClosures,
    resolveLiveWorkingOrderMatch,
} from "./portfolioOrders"
import {
    resolveExecutionSafetyFaultsFromProviderTruth,
    upsertProviderPositionRows,
    upsertProviderWorkingOrderRows,
} from "./portfolioRows"
import {
    updateProviderSyncStateFromCurrentRows,
    writeStrategyPositionSnapshots,
} from "./portfolioSnapshots"
import { detectExposureGovernanceViolations } from "./portfolioGovernance"
import {
    buildLiveInstrumentAliases,
    buildProtectionLevels,
    collectExpectedExternalInstruments,
    computeHash,
    createDriftSummary,
    isExpectedExternalProviderRow,
    isStale,
    readOrderCancelAt,
} from "./portfolioUtils"

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
        const providerStatus: Doc<"provider_sync_state">["providerStatus"] = driftDetected ? "degraded" : "healthy"
        const syncStateUpdate = {
            accountScope: "single-account-per-venue" as const,
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
        }

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
            await ctx.db.patch(previousState._id, syncStateUpdate)
        } else {
            await ctx.db.insert("provider_sync_state", {
                app: args.app,
                ...syncStateUpdate,
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

export { portfolioGovernanceTestables } from "./portfolioTestables"

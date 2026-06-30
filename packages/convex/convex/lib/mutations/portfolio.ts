import { mutation } from "../../_generated/server"
import type { Doc, Id } from "../../_generated/dataModel"
import { v } from "convex/values"
import {
    isCanonicalExecutionOrderId,
} from "@valiq-trading/core"
import { requireServiceToken } from "../authGuards"
import {
    getClaimInstrumentsForOrder,
    reconcileOrderInstrumentClaim,
    resolveAlpacaClaimedStructureForProviderLeg,
} from "../instrumentClaims"
import {
    buildProviderPositionKeyAliases,
    buildProviderPositionKey,
    resolveProviderPositionId,
} from "../providerPositions"
import {
    orderStatusV,
    venueAppV,
} from "../validators"
import { incrementControlPlaneMetric } from "../controlPlaneMetrics"
import {
    buildClaimsByInstrument,
    hasPositionOwnershipMismatch,
    repairMissingLivePositionClaimsFromFilledOrders,
    resolveOwnership,
} from "./portfolioOwnership"
import type { PortfolioMutationCtx } from "./portfolioTypes"
import {
    applyClosedOrderInference,
    applyProviderWorkingOrderUpdate,
    buildActiveOrderLookup,
    hasUnresolvedLiveWorkingOrderGap,
    importCanonicalProviderProtectionOrder,
    inferClosedOrderStatus,
    listActiveOrdersForApp,
    reconcileProviderPositionClosures,
    resolveTerminalLiveWorkingOrderRepairMatch,
    resolveLiveWorkingOrderMatch,
} from "./portfolioOrders"
import {
    resolveExecutionSafetyFaultsFromProviderTruth,
    upsertProviderPositionRows,
    upsertProviderWorkingOrderRows,
} from "./portfolioRows"
import {
    writeStrategyPositionSnapshots,
} from "./portfolioSnapshots"
import { reconcileAccountMoney } from "./portfolioMoneyAudit"
import { detectExposureGovernanceViolations } from "./portfolioGovernance"
import {
    buildLiveInstrumentAliases,
    buildProtectionLevels,
    collectExpectedExternalInstruments,
    computeHash,
    createDriftSummary,
    isExpectedExternalProviderRow,
    isStale,
    readMetadataRecord,
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
    canonicalOrderId: v.optional(v.string()),
    providerOrderId: v.optional(v.string()),
    providerClientOrderId: v.optional(v.string()),
    providerOrderAliases: v.optional(v.array(v.string())),
    signedOrderFingerprint: v.optional(v.string()),
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

const accountPnlEventInputV = v.object({
    providerEventId: v.string(),
    eventType: v.union(v.literal("funding_fee"), v.literal("fee"), v.literal("adjustment")),
    instrument: v.optional(v.string()),
    amount: v.number(),
    currency: v.string(),
    occurredAt: v.number(),
    metadata: v.optional(v.string()),
})

const operatorFlatReconciliationEvidenceV = v.object({
    livePositionCount: v.number(),
    liveWorkingOrderCount: v.number(),
    closureLookbackHours: v.optional(v.number()),
    note: v.string(),
})

type StrategyDoc = Doc<"strategies">
type OrderDoc = Doc<"orders">

export const reconcileProviderPortfolio = mutation({
    args: {
        serviceToken: v.string(),
        app: venueAppV,
        accountId: v.string(),
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
        accountPnlEvents: v.optional(v.array(accountPnlEventInputV)),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)

        const now = Date.now()
        const previousState = await ctx.db
            .query("provider_sync_state")
            .withIndex("by_app_account", (q) => q.eq("app", args.app).eq("accountId", args.accountId))
            .first()

        const strategies = await ctx.db
            .query("strategies")
            .withIndex("by_app_account", (q) => q.eq("app", args.app).eq("accountId", args.accountId))
            .collect()

        const strategyMap = new Map(strategies.map((strategy) => [String(strategy._id), strategy]))
        const activeOrders = await listActiveOrdersForApp(ctx, strategies)
        const activeOrdersById = buildActiveOrderLookup(activeOrders)
        const protectionLevelsByInstrument = buildProtectionLevels(args.workingOrders)
        const expectedExternalInstruments = collectExpectedExternalInstruments(strategies)
        const existingProviderPositions = await ctx.db
            .query("provider_positions")
            .withIndex("by_app_account", (q) => q.eq("app", args.app).eq("accountId", args.accountId))
            .collect()
        const existingProviderPositionsByKey = buildProviderPositionIndex(existingProviderPositions)
        const providerPositionClosures = args.positionClosures ?? []
        const accountPnlEvents = args.accountPnlEvents ?? []

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
            }) ?? await resolveTerminalLiveWorkingOrderRepairMatch(ctx, {
                app: args.app,
                accountId: args.accountId,
                liveOrder,
                matchedOrderIds: matchedActiveOrderIds,
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
                    accountId: strategy.accountId,
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
            accountId: args.accountId,
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
            .withIndex("by_app_account", (q) => q.eq("app", args.app).eq("accountId", args.accountId))
            .collect()
        const refreshedClaimsByInstrument = buildClaimsByInstrument(refreshedClaims, strategyMap)
        const ownershipMismatches = new Set<string>()

        const resolvedPositions = args.positions.map((position) => {
            const providerPositionId = resolveProviderPositionId(position.providerPositionId, position.metadata)
            const positionKey = buildProviderPositionKey({
                ...position,
                providerPositionId,
            })
            const previousPosition = existingProviderPositionsByKey.get(positionKey)
            const ownership = resolveOwnership({
                app: args.app,
                instrument: position.instrument,
                positionKey,
                claimsByInstrument: refreshedClaimsByInstrument,
                existingPositionByKey: existingProviderPositionsByKey,
                strategyMap,
            })
            const expectedExternal = ownership.ownershipStatus !== "owned" && isExpectedExternalProviderRow(
                expectedExternalInstruments,
                position
            )
            const metadata = mergeProviderPositionMetadata(
                resolveProviderPositionMetadataBase(position.metadata, previousPosition, ownership),
                resolveAlpacaPositionClaimMetadata({
                    app: args.app,
                    position,
                    ownership,
                    claims: refreshedClaims,
                })
            )

            if (
                hasPositionOwnershipMismatch({
                    positionKey,
                    existingPositionByKey: existingProviderPositionsByKey,
                    strategyMap,
                    resolvedOwnership: ownership,
                })
            ) {
                ownershipMismatches.add(positionKey)
            }

            return {
                ...position,
                providerPositionId,
                stopLoss: position.stopLoss ?? protectionLevelsByInstrument.get(position.instrument)?.stopLoss,
                takeProfit: position.takeProfit ?? protectionLevelsByInstrument.get(position.instrument)?.takeProfit,
                positionKey,
                expectedExternal,
                metadata,
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
                canonicalOrderId: existingOrder?.orderId ?? resolveCanonicalOrderIdFromProviderIdentity(order),
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
        await recordDuplicateExposureFaults(ctx, {
            app: args.app,
            accountId: args.accountId,
            violations: exposureViolations,
            strategies,
            updatedAt: now,
        })

        for (const existingOrder of activeOrders) {
            if (matchedActiveOrderIds.has(existingOrder.orderId)) {
                continue
            }

            if (hasUnresolvedLiveWorkingOrderGap(existingOrder, unresolvedOwnedWorkingOrders)) {
                continue
            }

            if (args.app === "mt5") {
                closedPersistedOrders.push(existingOrder.orderId)
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
                    accountId: strategy.accountId,
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
            accountId: args.accountId,
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

        const closureReconciliation = await reconcileProviderPositionClosures(ctx, {
            app: args.app,
            accountId: args.accountId,
            strategyMap,
            existingProviderPositions,
            livePositionKeys: buildLiveProviderPositionKeys(nextProviderPositions),
            positionClosures: providerPositionClosures,
            expectedExternalInstruments,
            updatedAt: now,
        })
        const repairedEntryOrderIds = new Set(closureReconciliation.repairedEntryOrderIds)
        const unresolvedClosedPersistedOrders = closedPersistedOrders.filter((orderId) =>
            !repairedEntryOrderIds.has(orderId)
        )

        const nextProviderWorkingOrders = resolvedWorkingOrders.map((order) => ({
            app: args.app,
            accountId: args.accountId,
            orderId: order.orderId,
            canonicalOrderId: order.canonicalOrderId,
            providerOrderId: order.providerOrderId,
            providerClientOrderId: order.providerClientOrderId,
            providerOrderAliases: order.providerOrderAliases,
            signedOrderFingerprint: order.signedOrderFingerprint,
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
        const moneyReconciliation = await reconcileAccountMoney(ctx, {
            app: args.app,
            accountId: args.accountId,
            venue: args.venue,
            strategies,
            currentAccountState: args.accountState,
            accountPnlEvents,
            updatedAt: now,
        })
        const accountPnlEventWriteStats = moneyReconciliation.eventWriteStats
        const moneyAuditMismatches = moneyReconciliation.moneyAuditMismatches

        if (shouldWriteAccountSnapshot) {
            await ctx.db.insert("account_snapshots", {
                app: args.app,
                accountId: args.accountId,
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

        const providerPositionWriteStats = await upsertProviderPositionRows(
            ctx,
            args.app,
            args.accountId,
            nextProviderPositions,
            now,
            existingProviderPositions
        )
        const providerWorkingOrderWriteStats = await upsertProviderWorkingOrderRows(ctx, args.app, args.accountId, nextProviderWorkingOrders)
        await resolveExecutionSafetyFaultsFromProviderTruth(ctx, {
            app: args.app,
            accountId: args.accountId,
            positions: nextProviderPositions,
            workingOrders: nextProviderWorkingOrders,
            updatedAt: now,
        })

        const positionSnapshotResult = await writeStrategyPositionSnapshots(ctx, {
            app: args.app,
            accountId: args.accountId,
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
            metric: "reconcile_provider_portfolio.account_pnl_events_inserted",
            app: args.app,
            delta: accountPnlEventWriteStats.inserted,
        })
        await incrementControlPlaneMetric(ctx, {
            metric: "reconcile_provider_portfolio.account_pnl_events_patched",
            app: args.app,
            delta: accountPnlEventWriteStats.patched,
        })
        await incrementControlPlaneMetric(ctx, {
            metric: "reconcile_provider_portfolio.account_pnl_events_unchanged",
            app: args.app,
            delta: accountPnlEventWriteStats.unchanged,
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
        await incrementControlPlaneMetric(ctx, {
            metric: "reconcile_provider_portfolio.unattributed_closures",
            app: args.app,
            delta: closureReconciliation.unattributedClosures.length,
        })
        await incrementControlPlaneMetric(ctx, {
            metric: "reconcile_provider_portfolio.unmatched_closed_positions",
            app: args.app,
            delta: closureReconciliation.unmatchedClosedPositions.length,
        })

        const driftSummary = createDriftSummary({
            unownedPositionCount: unownedPositions.length,
            unownedOrderCount: unownedOrders.length,
            untrackedOwnedOrderCount: unresolvedOwnedWorkingOrders.length,
            closedPersistedOrders: unresolvedClosedPersistedOrders,
            statusMismatches,
            ownershipMismatches: Array.from(ownershipMismatches),
            exposureViolations,
            moneyAuditMismatches,
            unattributedClosures: closureReconciliation.unattributedClosures,
            unmatchedClosedPositions: closureReconciliation.unmatchedClosedPositions,
        })
        const driftDetected = driftSummary !== undefined
        const stale = false
        const providerStatus: Doc<"provider_sync_state">["providerStatus"] = driftDetected ? "degraded" : "healthy"
        const syncStateUpdate = {
            accountId: args.accountId,
            accountScope: "account" as const,
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
                message: `[portfolio] ${args.app}:${args.accountId} reconciliation drift (${args.source}): ${driftSummary}`,
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
            accountId: args.accountId,
            source: args.source,
            positionCount: resolvedPositions.length,
            pendingOrderCount: resolvedWorkingOrders.length,
            driftDetected,
            driftSummary,
        }
    },
})

function resolveCanonicalOrderIdFromProviderIdentity(order: {
    canonicalOrderId?: string
    providerClientOrderId?: string
    providerOrderAliases?: string[]
    signedOrderFingerprint?: string
    metadata?: string
}): string | undefined {
    const metadata = readMetadataRecord(order.metadata)
    const candidates = [
        order.canonicalOrderId,
        order.providerClientOrderId,
        ...(order.providerOrderAliases ?? []),
        typeof metadata?.canonicalOrderId === "string" ? metadata.canonicalOrderId : undefined,
        typeof metadata?.providerClientOrderId === "string" ? metadata.providerClientOrderId : undefined,
    ]

    return candidates.find(isCanonicalExecutionOrderId)
}

function buildProviderPositionIndex(
    positions: Doc<"provider_positions">[]
): Map<string, Doc<"provider_positions">> {
    const index = new Map<string, Doc<"provider_positions">>()

    for (const position of positions) {
        index.set(position.positionKey, position)
        for (const alias of buildProviderPositionKeyAliases(position)) {
            index.set(alias, position)
        }
    }

    return index
}

function buildLiveProviderPositionKeys(
    positions: Array<{
        instrument: string
        side: string
        providerPositionId?: string
        metadata?: string
        positionKey: string
    }>
): Set<string> {
    const keys = new Set<string>()

    for (const position of positions) {
        keys.add(position.positionKey)
        for (const alias of buildProviderPositionKeyAliases(position)) {
            keys.add(alias)
        }
    }

    return keys
}

function resolveAlpacaPositionClaimMetadata(args: {
    app: Doc<"strategies">["app"]
    position: { instrument: string }
    ownership: { strategyId?: Id<"strategies">; ownershipStatus: string }
    claims: Array<Doc<"instrument_claims">>
}): Record<string, unknown> | undefined {
    if (
        args.app !== "alpaca-options" ||
        args.ownership.ownershipStatus !== "owned" ||
        !args.ownership.strategyId
    ) {
        return undefined
    }

    const claim = resolveAlpacaClaimedStructureForProviderLeg({
        instrument: args.position.instrument,
        strategyId: String(args.ownership.strategyId),
        claims: args.claims,
    })
    if (!claim) {
        return undefined
    }

    return {
        alpacaClaimInstrument: claim.instrument,
        alpacaClaimStructureType: claim.structureType,
        alpacaClaimVerticalSpreadType: claim.verticalSpreadType,
        alpacaClaimUnderlying: claim.underlying,
        alpacaClaimExpiration: claim.expiration,
        alpacaClaimLegs: claim.legs,
    }
}

function mergeProviderPositionMetadata(
    current: string | undefined,
    extra: Record<string, unknown> | undefined
): string | undefined {
    if (!extra) {
        return current
    }

    return JSON.stringify({
        ...(readMetadataRecord(current) ?? {}),
        ...extra,
    })
}

function resolveProviderPositionMetadataBase(
    current: string | undefined,
    previousPosition: Doc<"provider_positions"> | undefined,
    ownership: { strategyId?: Id<"strategies">; ownershipStatus: string }
): string | undefined {
    if (current) {
        return current
    }

    if (
        ownership.ownershipStatus === "owned" &&
        ownership.strategyId &&
        previousPosition?.strategyId === ownership.strategyId
    ) {
        return previousPosition.metadata
    }

    return undefined
}

async function recordDuplicateExposureFaults(
    ctx: PortfolioMutationCtx,
    args: {
        app: Doc<"strategies">["app"]
        accountId: string
        violations: string[]
        strategies: Array<Doc<"strategies">>
        updatedAt: number
    }
): Promise<void> {
    if (args.violations.length === 0) {
        return
    }

    const strategyMap = new Map(args.strategies.map((strategy) => [String(strategy._id), strategy]))
    const existingFaults = await ctx.db
        .query("execution_safety_faults")
        .withIndex("by_app_account_blocked", (q) =>
            q.eq("app", args.app).eq("accountId", args.accountId).eq("blocked", true)
        )
        .collect()
    const existingKeys = new Set(
        existingFaults
            .filter((fault) => fault.category === "duplicate_exposure")
            .map((fault) => `${String(fault.strategyId)}:${fault.instrument}:${fault.message}`)
    )

    for (const violation of args.violations) {
        const parsed = parseExposureViolation(violation)
        if (!parsed) {
            continue
        }

        const strategy = strategyMap.get(parsed.strategyId)
        if (!strategy) {
            continue
        }

        const message = `Provider reconciliation proved duplicate exposure: ${parsed.kind} on ${parsed.instrument}`
        const key = `${parsed.strategyId}:${parsed.instrument}:${message}`
        if (existingKeys.has(key)) {
            continue
        }

        await ctx.db.insert("execution_safety_faults", {
            strategyId: strategy._id,
            app: args.app,
            accountId: args.accountId,
            instrument: parsed.instrument,
            category: "duplicate_exposure",
            message,
            providerPayload: JSON.stringify({
                violation,
                kind: parsed.kind,
                instrument: parsed.instrument,
            }),
            blocked: true,
            occurredAt: args.updatedAt,
            resolvedAt: undefined,
            resolutionNote: undefined,
        })
        await ctx.db.insert("alerts", {
            strategyId: strategy._id,
            app: args.app,
            severity: "critical",
            message: `[execution-safety] ${strategy.name} ${parsed.instrument}: duplicate_exposure -- ${message}`,
            acknowledged: false,
            timestamp: args.updatedAt,
        })
        existingKeys.add(key)
    }
}

function parseExposureViolation(violation: string): {
    strategyId: string
    kind: string
    instrument: string
} | undefined {
    const [strategyId, kind, ...instrumentParts] = violation.split(":")
    const instrument = instrumentParts.join(":")

    if (!strategyId || !kind || !instrument) {
        return undefined
    }

    return {
        strategyId,
        kind,
        instrument,
    }
}

export const recordProviderSyncFailure = mutation({
    args: {
        serviceToken: v.string(),
        app: venueAppV,
        accountId: v.string(),
        error: v.string(),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        const now = Date.now()
        const existing = await ctx.db
            .query("provider_sync_state")
            .withIndex("by_app_account", (q) => q.eq("app", args.app).eq("accountId", args.accountId))
            .first()
        const lastVerifiedAt = existing?.lastVerifiedAt
        const stale = isStale(lastVerifiedAt, now)

        if (existing) {
            await ctx.db.patch(existing._id, {
                accountScope: "account",
                providerStatus: stale ? "stale" : "degraded",
                stale,
                lastError: args.error,
                updatedAt: now,
            })
            return existing._id
        }

        return await ctx.db.insert("provider_sync_state", {
            app: args.app,
            accountId: args.accountId,
            accountScope: "account",
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

export const operatorReconcileVerifiedFlatProviderState = mutation({
    args: {
        serviceToken: v.string(),
        app: venueAppV,
        accountId: v.string(),
        evidence: operatorFlatReconciliationEvidenceV,
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)

        if (args.evidence.note.trim().length === 0) {
            throw new Error("Operator flat reconciliation requires a non-empty evidence note")
        }

        const now = Date.now()
        const [positions, workingOrders, historyRows, previousState] = await Promise.all([
            ctx.db
                .query("provider_positions")
                .withIndex("by_app_account", (q) => q.eq("app", args.app).eq("accountId", args.accountId))
                .collect(),
            ctx.db
                .query("provider_working_orders")
                .withIndex("by_app_account", (q) => q.eq("app", args.app).eq("accountId", args.accountId))
                .collect(),
            ctx.db
                .query("provider_position_history")
                .withIndex("by_app_account_retained_until", (q) =>
                    q
                        .eq("app", args.app)
                        .eq("accountId", args.accountId)
                        .gte("retainedUntil", now)
                )
                .collect(),
            ctx.db
                .query("provider_sync_state")
                .withIndex("by_app_account", (q) => q.eq("app", args.app).eq("accountId", args.accountId))
                .first(),
        ])

        if (positions.length !== args.evidence.livePositionCount) {
            throw new Error(`Cannot operator-reconcile ${args.app}:${args.accountId} provider positions while Convex has ${positions.length} provider position(s) and broker evidence has ${args.evidence.livePositionCount}`)
        }

        if (workingOrders.length !== args.evidence.liveWorkingOrderCount) {
            throw new Error(`Cannot operator-reconcile ${args.app}:${args.accountId} provider positions while Convex has ${workingOrders.length} provider working order(s) and broker evidence has ${args.evidence.liveWorkingOrderCount}`)
        }

        const livePositionKeys = new Set(positions.map((position) => position.positionKey))
        const stillLiveHistoryRows = historyRows.filter((row) => livePositionKeys.has(row.positionKey))
        if (stillLiveHistoryRows.length > 0) {
            throw new Error(`Cannot operator-reconcile ${args.app}:${args.accountId} retained provider history while ${stillLiveHistoryRows.length} retained position(s) are still live`)
        }

        for (const row of historyRows) {
            await ctx.db.patch(row._id, {
                retainedUntil: Math.min(row.retainedUntil, now),
                operatorReconciledAt: now,
                operatorReconciliationEvidence: args.evidence.note,
            })
        }

        const syncStateUpdate = {
            accountId: args.accountId,
            accountScope: "account" as const,
            lastSyncedAt: now,
            lastVerifiedAt: now,
            providerStatus: "healthy" as const,
            stale: false,
            driftDetected: false,
            lastError: undefined,
            lastDriftSummary: undefined,
            positionCount: positions.length,
            pendingOrderCount: workingOrders.length,
            updatedAt: now,
        }

        if (previousState) {
            await ctx.db.patch(previousState._id, syncStateUpdate)
        } else {
            await ctx.db.insert("provider_sync_state", {
                app: args.app,
                ...syncStateUpdate,
            })
        }

        await ctx.db.insert("alerts", {
            app: args.app,
            severity: "info",
            message: `[portfolio] ${args.app}:${args.accountId} operator reconciled verified provider state; preserved ${historyRows.length} retained provider history row(s). Evidence: ${args.evidence.note}`,
            acknowledged: false,
            timestamp: now,
        })

        return {
            app: args.app,
            accountId: args.accountId,
            deletedProviderPositionHistory: 0,
            preservedProviderPositionHistory: historyRows.length,
            positionCount: positions.length,
            pendingOrderCount: workingOrders.length,
            providerStatus: "healthy" as const,
            driftDetected: false,
        }
    },
})

export { portfolioGovernanceTestables } from "./portfolioTestables"

import type { Doc, Id } from "../../_generated/dataModel"
import { buildPositionClaim } from "../providerPositions"
import { replacePositionClaims } from "../instrumentClaims"
import type {
    OrderDoc,
    PortfolioMutationCtx,
    ProviderPositionInput,
    StrategyDoc,
} from "./portfolioTypes"
import {
    buildActiveOrderLookup,
    listActiveOrdersForApp,
} from "./portfolioOrders"
import { detectExposureGovernanceViolations } from "./portfolioGovernance"
import {
    computeHash,
    createDriftSummary,
    isStale,
} from "./portfolioUtils"

type StrategySnapshotPosition = ProviderPositionInput & {
    positionKey?: string
}

export async function updateProviderSyncStateFromCurrentRows(
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

export async function writeStrategyPositionSnapshots(
    ctx: PortfolioMutationCtx,
    args: {
        app: Doc<"strategies">["app"]
        strategies: StrategyDoc[]
        positions: Array<{
            strategyId?: Id<"strategies">
        } & StrategySnapshotPosition>
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
        const snapshotHash = computeHash(buildStrategyPositionSnapshotHashPayload(strategyPositions))
        const latestSync = await ctx.db
            .query("position_syncs")
            .withIndex("by_strategy_synced_at", (q) => q.eq("strategyId", strategy._id))
            .order("desc")
            .first()

        const unchanged = latestSync?.snapshotHash === snapshotHash
        if (unchanged) {
            skipped++
            appendSnapshotHash(hashInput, strategy._id, snapshotHash, false)
            await replaceStrategyPositionClaims(ctx, args.app, strategy._id, strategyPositions, args.syncedAt)
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
                positionKey: position.positionKey,
                providerPositionId: position.providerPositionId,
                instrument: position.instrument,
                side: position.side,
                quantity: position.quantity,
                entryPrice: position.entryPrice,
                currentPrice: position.currentPrice,
                unrealizedPnl: position.unrealizedPnl,
                stopLoss: position.stopLoss,
                takeProfit: position.takeProfit,
                metadata: position.metadata,
                syncedAt: args.syncedAt,
            })
        }

        await replaceStrategyPositionClaims(ctx, args.app, strategy._id, strategyPositions, args.syncedAt)

        written++
        appendSnapshotHash(hashInput, strategy._id, snapshotHash, true)
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

export function buildStrategyPositionSnapshotHashPayload(
    positions: StrategySnapshotPosition[]
): StrategySnapshotPosition[] {
    return positions
        .map((position) => ({
            instrument: position.instrument,
            positionKey: position.positionKey,
            providerPositionId: position.providerPositionId,
            side: position.side,
            quantity: position.quantity,
            entryPrice: position.entryPrice,
            currentPrice: position.currentPrice,
            unrealizedPnl: position.unrealizedPnl,
            stopLoss: position.stopLoss,
            takeProfit: position.takeProfit,
            metadata: position.metadata,
        }))
        .sort((left, right) =>
            `${left.instrument}:${left.positionKey ?? left.providerPositionId ?? left.side}`.localeCompare(
                `${right.instrument}:${right.positionKey ?? right.providerPositionId ?? right.side}`
            )
        )
}

function isDryRunStrategy(strategy: StrategyDoc): boolean {
    return Boolean((strategy.policy as Record<string, unknown>).dryRun)
}

function appendSnapshotHash(
    hashInput: Array<{ strategyId: string; snapshotHash: string; written: boolean }>,
    strategyId: Id<"strategies">,
    snapshotHash: string,
    written: boolean
): void {
    hashInput.push({
        strategyId: String(strategyId),
        snapshotHash,
        written,
    })
}

async function replaceStrategyPositionClaims(
    ctx: PortfolioMutationCtx,
    app: Doc<"strategies">["app"],
    strategyId: Id<"strategies">,
    positions: Array<{
        positionKey?: string
        instrument: string
        side: string
        providerPositionId?: string
        metadata?: string
    }>,
    updatedAt: number
): Promise<void> {
    await replacePositionClaims(ctx, {
        strategyId,
        app,
        positionClaims: positions.flatMap(buildSnapshotPositionClaims),
        updatedAt,
    })
}

function buildSnapshotPositionClaims(position: {
    positionKey?: string
    instrument: string
    side: string
    providerPositionId?: string
    metadata?: string
}): Array<{ instrument: string; sourceId?: string }> {
    const claims = [buildPositionClaim(position)]
    const metadata = readMetadataRecord(position.metadata)
    const claimInstrument = readString(metadata?.alpacaClaimInstrument)

    if (claimInstrument) {
        claims.push({
            instrument: claimInstrument,
            sourceId: claimInstrument,
        })
    }

    return claims
}

function readMetadataRecord(metadata: string | undefined): Record<string, unknown> | undefined {
    if (!metadata) {
        return undefined
    }

    try {
        const parsed = JSON.parse(metadata)
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : undefined
    } catch {
        return undefined
    }
}

function readString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim()
        ? value.trim()
        : undefined
}

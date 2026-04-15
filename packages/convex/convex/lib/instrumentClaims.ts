import type { OrderAction, OrderStatus } from "@valiq-trading/core"
import { isActiveEntryOrderStatus } from "@valiq-trading/core"
import type { Id, Doc } from "../_generated/dataModel"
import type { MutationCtx, QueryCtx } from "../_generated/server"

type QueryDbCtx = {
    db: QueryCtx["db"]
}

type MutationDbCtx = {
    db: MutationCtx["db"]
}

type VenueApp = Doc<"strategies">["app"]
type ClaimSource = Doc<"instrument_claims">["source"]

const POSITION_CLAIM_SOURCE: ClaimSource = "position"
const ORDER_CLAIM_SOURCE: ClaimSource = "order"

function uniqueInstruments(instruments: string[]): string[] {
    return Array.from(
        new Set(
            instruments
                .map((instrument) => instrument.trim())
                .filter((instrument) => instrument.length > 0)
        )
    )
}

function compareStrategiesForBootstrap(left: Doc<"strategies">, right: Doc<"strategies">): number {
    if (left.createdAt !== right.createdAt) {
        return left.createdAt - right.createdAt
    }

    return String(left._id).localeCompare(String(right._id))
}

function isEntryLikeAction(action: OrderAction): boolean {
    return action === "entry" || action === "adjustment"
}

async function getClaimBySource(
    ctx: MutationDbCtx,
    strategyId: Id<"strategies">,
    source: ClaimSource,
    sourceId: string
): Promise<Doc<"instrument_claims"> | null> {
    return await ctx.db
        .query("instrument_claims")
        .withIndex("by_strategy_source_source_id", (q) =>
            q.eq("strategyId", strategyId).eq("source", source).eq("sourceId", sourceId)
        )
        .first()
}

async function upsertClaim(
    ctx: MutationDbCtx,
    args: {
        strategyId: Id<"strategies">
        app: VenueApp
        instrument: string
        source: ClaimSource
        sourceId: string
        updatedAt: number
    }
): Promise<void> {
    const existing = await getClaimBySource(ctx, args.strategyId, args.source, args.sourceId)

    if (existing) {
        if (
            existing.app === args.app &&
            existing.instrument === args.instrument
        ) {
            return
        }

        await ctx.db.patch(existing._id, {
            app: args.app,
            instrument: args.instrument,
            updatedAt: args.updatedAt,
        })
        return
    }

    await ctx.db.insert("instrument_claims", {
        strategyId: args.strategyId,
        app: args.app,
        instrument: args.instrument,
        source: args.source,
        sourceId: args.sourceId,
        updatedAt: args.updatedAt,
    })
}

async function deleteOrderClaims(
    ctx: MutationDbCtx,
    strategyId: Id<"strategies">,
    orderId: string
): Promise<void> {
    const claims = await ctx.db
        .query("instrument_claims")
        .withIndex("by_strategy_source", (q) =>
            q.eq("strategyId", strategyId).eq("source", ORDER_CLAIM_SOURCE)
        )
        .collect()

    for (const claim of claims) {
        if (claim.sourceId === orderId || claim.sourceId.startsWith(`${orderId}:`)) {
            await ctx.db.delete(claim._id)
        }
    }
}

function buildOrderClaimSourceId(orderId: string, instrument: string): string {
    return `${orderId}:${instrument}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null
}

export function getClaimInstrumentsForOrder(instrument: string, intent?: unknown): string[] {
    if (!isRecord(intent) || !Array.isArray(intent.legs)) {
        return uniqueInstruments([instrument])
    }

    const legInstruments = intent.legs
        .filter(isRecord)
        .map((leg) => typeof leg.instrument === "string" ? leg.instrument : "")

    return uniqueInstruments([instrument, ...legInstruments])
}

export async function getLatestPositionsForStrategy(
    ctx: QueryDbCtx,
    strategyId: Id<"strategies">
): Promise<Array<Doc<"positions">>> {
    const latestSync = await ctx.db
        .query("position_syncs")
        .withIndex("by_strategy_synced_at", (q) => q.eq("strategyId", strategyId))
        .order("desc")
        .first()

    if (!latestSync || latestSync.positionCount === 0) {
        return []
    }

    return await ctx.db
        .query("positions")
        .withIndex("by_strategy_synced_at", (q) =>
            q.eq("strategyId", strategyId).eq("syncedAt", latestSync.syncedAt)
        )
        .collect()
}

export async function getClaimedInstrumentsForStrategy(
    ctx: QueryDbCtx,
    strategyId: Id<"strategies">
): Promise<string[]> {
    const claims = await ctx.db
        .query("instrument_claims")
        .withIndex("by_strategy", (q) => q.eq("strategyId", strategyId))
        .collect()

    return uniqueInstruments(claims.map((claim) => claim.instrument))
}

export async function getOwnedInstrumentsForStrategy(
    ctx: QueryDbCtx,
    strategyId: Id<"strategies">
): Promise<string[]> {
    const claimedInstruments = await getClaimedInstrumentsForStrategy(ctx, strategyId)
    if (claimedInstruments.length > 0) {
        return claimedInstruments
    }

    const strategy = await ctx.db.get(strategyId)
    if (!strategy) {
        return []
    }

    const appOwnedInstruments = await getOwnedInstrumentsByApp(ctx, strategy.app)
    return uniqueInstruments(
        appOwnedInstruments
            .filter((entry) => entry.strategyId === strategyId)
            .map((entry) => entry.instrument)
    )
}

export async function getOwnedInstrumentsByApp(
    ctx: QueryDbCtx,
    app: VenueApp
): Promise<Array<{ instrument: string; strategyId: Id<"strategies"> }>> {
    const [strategies, claims] = await Promise.all([
        ctx.db
            .query("strategies")
            .withIndex("by_app", (q) => q.eq("app", app))
            .collect(),
        ctx.db
            .query("instrument_claims")
            .withIndex("by_app", (q) => q.eq("app", app))
            .collect(),
    ])

    const claimedByStrategy = new Map<string, string[]>()
    for (const claim of claims) {
        const key = String(claim.strategyId)
        const instruments = claimedByStrategy.get(key) ?? []
        instruments.push(claim.instrument)
        claimedByStrategy.set(key, instruments)
    }

    const reservedInstruments = new Set(claims.map((claim) => claim.instrument))
    const owned: Array<{ instrument: string; strategyId: Id<"strategies"> }> = []
    const orderedStrategies = [...strategies].sort(compareStrategiesForBootstrap)
    for (const strategy of orderedStrategies) {
        const claimed = claimedByStrategy.get(String(strategy._id))
        if (claimed && claimed.length > 0) {
            for (const instrument of uniqueInstruments(claimed)) {
                owned.push({ instrument, strategyId: strategy._id })
            }
            continue
        }

        const positions = await getLatestPositionsForStrategy(ctx, strategy._id)
        for (const instrument of uniqueInstruments(positions.map((position) => position.instrument))) {
            if (reservedInstruments.has(instrument)) {
                continue
            }

            owned.push({ instrument, strategyId: strategy._id })
            reservedInstruments.add(instrument)
        }
    }

    return owned
}

export async function replacePositionClaims(
    ctx: MutationDbCtx,
    args: {
        strategyId: Id<"strategies">
        app: VenueApp
        instruments: string[]
        updatedAt: number
    }
): Promise<void> {
    const nextInstruments = uniqueInstruments(args.instruments)
    const nextInstrumentSet = new Set(nextInstruments)
    const existingClaims = await ctx.db
        .query("instrument_claims")
        .withIndex("by_strategy_source", (q) =>
            q.eq("strategyId", args.strategyId).eq("source", POSITION_CLAIM_SOURCE)
        )
        .collect()

    for (const claim of existingClaims) {
        if (!nextInstrumentSet.has(claim.instrument)) {
            await ctx.db.delete(claim._id)
        }
    }

    for (const instrument of nextInstruments) {
        await upsertClaim(ctx, {
            strategyId: args.strategyId,
            app: args.app,
            instrument,
            source: POSITION_CLAIM_SOURCE,
            sourceId: instrument,
            updatedAt: args.updatedAt,
        })
    }
}

export async function upsertPositionInstrumentClaims(
    ctx: MutationDbCtx,
    args: {
        strategyId: Id<"strategies">
        app: VenueApp
        instruments: string[]
        updatedAt: number
    }
): Promise<void> {
    for (const instrument of uniqueInstruments(args.instruments)) {
        await upsertClaim(ctx, {
            strategyId: args.strategyId,
            app: args.app,
            instrument,
            source: POSITION_CLAIM_SOURCE,
            sourceId: instrument,
            updatedAt: args.updatedAt,
        })
    }
}

export async function reconcileOrderInstrumentClaim(
    ctx: MutationDbCtx,
    args: {
        strategyId: Id<"strategies">
        app: VenueApp
        orderId: string
        instrument: string
        claimInstruments?: string[]
        action: OrderAction
        status: OrderStatus
        updatedAt: number
    }
): Promise<void> {
    const instruments = uniqueInstruments(args.claimInstruments ?? [args.instrument])

    if (isEntryLikeAction(args.action)) {
        if (isActiveEntryOrderStatus(args.status)) {
            await deleteOrderClaims(ctx, args.strategyId, args.orderId)
            for (const instrument of instruments) {
                await upsertClaim(ctx, {
                    strategyId: args.strategyId,
                    app: args.app,
                    instrument,
                    source: ORDER_CLAIM_SOURCE,
                    sourceId: buildOrderClaimSourceId(args.orderId, instrument),
                    updatedAt: args.updatedAt,
                })
            }
            return
        }

        await deleteOrderClaims(ctx, args.strategyId, args.orderId)

        if (args.status === "filled") {
            await upsertPositionInstrumentClaims(ctx, {
                strategyId: args.strategyId,
                app: args.app,
                instruments,
                updatedAt: args.updatedAt,
            })
        }
        return
    }

    await deleteOrderClaims(ctx, args.strategyId, args.orderId)
}

import { isActiveEntryOrderStatus } from "@valiq-trading/core";
const POSITION_CLAIM_SOURCE = "position";
const ORDER_CLAIM_SOURCE = "order";
function uniqueInstruments(instruments) {
    return Array.from(new Set(instruments));
}
function compareStrategiesForBootstrap(left, right) {
    if (left.createdAt !== right.createdAt) {
        return left.createdAt - right.createdAt;
    }
    return String(left._id).localeCompare(String(right._id));
}
function isEntryLikeAction(action) {
    return action === "entry" || action === "adjustment";
}
async function getClaimBySource(ctx, strategyId, source, sourceId) {
    return await ctx.db
        .query("instrument_claims")
        .withIndex("by_strategy_source_source_id", (q) => q.eq("strategyId", strategyId).eq("source", source).eq("sourceId", sourceId))
        .first();
}
async function upsertClaim(ctx, args) {
    const existing = await getClaimBySource(ctx, args.strategyId, args.source, args.sourceId);
    if (existing) {
        await ctx.db.patch(existing._id, {
            app: args.app,
            instrument: args.instrument,
            updatedAt: args.updatedAt,
        });
        return;
    }
    await ctx.db.insert("instrument_claims", {
        strategyId: args.strategyId,
        app: args.app,
        instrument: args.instrument,
        source: args.source,
        sourceId: args.sourceId,
        updatedAt: args.updatedAt,
    });
}
async function deleteClaim(ctx, strategyId, source, sourceId) {
    const existing = await getClaimBySource(ctx, strategyId, source, sourceId);
    if (!existing) {
        return;
    }
    await ctx.db.delete(existing._id);
}
export async function getLatestPositionsForStrategy(ctx, strategyId) {
    const latestSync = await ctx.db
        .query("position_syncs")
        .withIndex("by_strategy_synced_at", (q) => q.eq("strategyId", strategyId))
        .order("desc")
        .first();
    if (!latestSync || latestSync.positionCount === 0) {
        return [];
    }
    return await ctx.db
        .query("positions")
        .withIndex("by_strategy_synced_at", (q) => q.eq("strategyId", strategyId).eq("syncedAt", latestSync.syncedAt))
        .collect();
}
export async function getClaimedInstrumentsForStrategy(ctx, strategyId) {
    const claims = await ctx.db
        .query("instrument_claims")
        .withIndex("by_strategy", (q) => q.eq("strategyId", strategyId))
        .collect();
    return uniqueInstruments(claims.map((claim) => claim.instrument));
}
export async function getOwnedInstrumentsForStrategy(ctx, strategyId) {
    const claimedInstruments = await getClaimedInstrumentsForStrategy(ctx, strategyId);
    if (claimedInstruments.length > 0) {
        return claimedInstruments;
    }
    const strategy = await ctx.db.get(strategyId);
    if (!strategy) {
        return [];
    }
    const appOwnedInstruments = await getOwnedInstrumentsByApp(ctx, strategy.app);
    return uniqueInstruments(appOwnedInstruments
        .filter((entry) => entry.strategyId === strategyId)
        .map((entry) => entry.instrument));
}
export async function getOwnedInstrumentsByApp(ctx, app) {
    const [strategies, claims] = await Promise.all([
        ctx.db
            .query("strategies")
            .withIndex("by_app", (q) => q.eq("app", app))
            .collect(),
        ctx.db
            .query("instrument_claims")
            .withIndex("by_app", (q) => q.eq("app", app))
            .collect(),
    ]);
    const claimedByStrategy = new Map();
    for (const claim of claims) {
        const key = String(claim.strategyId);
        const instruments = claimedByStrategy.get(key) ?? [];
        instruments.push(claim.instrument);
        claimedByStrategy.set(key, instruments);
    }
    const reservedInstruments = new Set(claims.map((claim) => claim.instrument));
    const owned = [];
    const orderedStrategies = [...strategies].sort(compareStrategiesForBootstrap);
    for (const strategy of orderedStrategies) {
        const claimed = claimedByStrategy.get(String(strategy._id));
        if (claimed && claimed.length > 0) {
            for (const instrument of uniqueInstruments(claimed)) {
                owned.push({ instrument, strategyId: strategy._id });
            }
            continue;
        }
        const positions = await getLatestPositionsForStrategy(ctx, strategy._id);
        for (const instrument of uniqueInstruments(positions.map((position) => position.instrument))) {
            if (reservedInstruments.has(instrument)) {
                continue;
            }
            owned.push({ instrument, strategyId: strategy._id });
            reservedInstruments.add(instrument);
        }
    }
    return owned;
}
export async function replacePositionClaims(ctx, args) {
    const nextInstruments = uniqueInstruments(args.instruments);
    const nextInstrumentSet = new Set(nextInstruments);
    const existingClaims = await ctx.db
        .query("instrument_claims")
        .withIndex("by_strategy_source", (q) => q.eq("strategyId", args.strategyId).eq("source", POSITION_CLAIM_SOURCE))
        .collect();
    for (const claim of existingClaims) {
        if (!nextInstrumentSet.has(claim.instrument)) {
            await ctx.db.delete(claim._id);
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
        });
    }
}
export async function reconcileOrderInstrumentClaim(ctx, args) {
    if (isEntryLikeAction(args.action)) {
        if (isActiveEntryOrderStatus(args.status)) {
            await upsertClaim(ctx, {
                strategyId: args.strategyId,
                app: args.app,
                instrument: args.instrument,
                source: ORDER_CLAIM_SOURCE,
                sourceId: args.orderId,
                updatedAt: args.updatedAt,
            });
            return;
        }
        await deleteClaim(ctx, args.strategyId, ORDER_CLAIM_SOURCE, args.orderId);
        if (args.status === "filled") {
            await upsertClaim(ctx, {
                strategyId: args.strategyId,
                app: args.app,
                instrument: args.instrument,
                source: POSITION_CLAIM_SOURCE,
                sourceId: args.instrument,
                updatedAt: args.updatedAt,
            });
        }
        return;
    }
    await deleteClaim(ctx, args.strategyId, ORDER_CLAIM_SOURCE, args.orderId);
}

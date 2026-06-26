import type { Doc, Id } from "../../_generated/dataModel"
import {
    getClaimInstrumentsForOrder,
    getProviderInstrumentClaimAliases,
    upsertPositionInstrumentClaims,
} from "../instrumentClaims"
import type {
    OrderDoc,
    PortfolioMutationCtx,
    ResolvedOwnership,
    StrategyDoc,
} from "./portfolioTypes"
import {
    isEntryLikeOrder,
    setsIntersect,
} from "./portfolioUtils"

export function buildClaimsByInstrument(
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

export async function repairMissingLivePositionClaimsFromFilledOrders(
    ctx: PortfolioMutationCtx,
    args: {
        app: Doc<"strategies">["app"]
        accountId: string
        strategyMap: Map<string, StrategyDoc>
        liveInstrumentAliases: Map<string, Set<string>>
        updatedAt: number
    }
): Promise<void> {
    if (args.liveInstrumentAliases.size === 0) {
        return
    }

    const existingClaims = await ctx.db
        .query("instrument_claims")
        .withIndex("by_app_account", (q) => q.eq("app", args.app).eq("accountId", args.accountId))
        .collect()
    const claimedInstruments = new Set(existingClaims.map((claim) => claim.instrument))
    const unclaimedLiveInstrumentAliases = new Map(
        Array.from(args.liveInstrumentAliases.entries()).filter(([liveInstrument]) =>
            !claimedInstruments.has(liveInstrument)
        )
    )
    if (unclaimedLiveInstrumentAliases.size === 0) {
        return
    }

    const filledOrders = (
        await Promise.all(
            Array.from(args.strategyMap.values()).map(async (strategy) => await ctx.db
                .query("orders")
                .withIndex("by_strategy_status", (q) =>
                    q.eq("strategyId", strategy._id).eq("status", "filled")
                )
                .collect())
        )
    ).flat()
    const candidateStrategiesByInstrument = new Map<string, Set<Id<"strategies">>>()

    for (const order of filledOrders) {
        if (!isEntryLikeOrder(order) || !args.strategyMap.has(String(order.strategyId))) {
            continue
        }

        const orderAliases = new Set(getClaimInstrumentsForOrder(order.instrument, order.intent))
        for (const [liveInstrument, liveAliases] of unclaimedLiveInstrumentAliases) {
            if (!setsIntersect(orderAliases, liveAliases)) {
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
            accountId: args.accountId,
            instruments: entry.instruments,
            updatedAt: args.updatedAt,
        })
    }
}

export function resolveOwnership(args: {
    app: Doc<"strategies">["app"]
    instrument: string
    positionKey?: string
    claimsByInstrument: Map<string, Set<Id<"strategies">>>
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

    const claims = collectClaimsForAliases(
        args.claimsByInstrument,
        getProviderInstrumentClaimAliases(args.app, args.instrument)
    )

    if (args.positionKey && args.existingPositionByKey) {
        const existingStrategyId = readKnownStrategyId(
            args.existingPositionByKey.get(args.positionKey)?.strategyId,
            args.strategyMap
        )
        if (existingStrategyId) {
            if (!claims || claims.size === 0 || claims.has(existingStrategyId) && claims.size === 1) {
                return {
                    strategyId: existingStrategyId,
                    ownershipStatus: "owned",
                }
            }

            return {
                ownershipStatus: "orphaned",
            }
        }
    }

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

export function collectClaimsForAliases(
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

export function hasPositionOwnershipMismatch(args: {
    positionKey: string
    existingPositionByKey?: Map<string, Doc<"provider_positions">>
    strategyMap?: Map<string, StrategyDoc>
    resolvedOwnership: ResolvedOwnership
}): boolean {
    const existingStrategyId = readKnownStrategyId(
        args.existingPositionByKey?.get(args.positionKey)?.strategyId,
        args.strategyMap
    )

    return Boolean(
        existingStrategyId &&
        (
            args.resolvedOwnership.ownershipStatus !== "owned" ||
            args.resolvedOwnership.strategyId !== existingStrategyId
        )
    )
}

export function readKnownStrategyId(
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

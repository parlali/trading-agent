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

export function buildPositionClaimsByKey(
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

export function buildAdoptedPositionClaims(args: {
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

export async function repairMissingLivePositionClaimsFromFilledOrders(
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

export function resolveOwnership(args: {
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

export function resolvePositionOwnership(args: {
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

export function hasPositionOwnershipMismatch(args: {
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

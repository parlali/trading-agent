import type { OrderAction, OrderStatus } from "@valiq-trading/core"
import {
    buildPolymarketConditionInstrumentAlias,
    isActiveEntryOrderStatus,
    readPolymarketConditionId,
} from "@valiq-trading/core"
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
        accountId: string
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
            existing.accountId === args.accountId &&
            existing.instrument === args.instrument
        ) {
            return
        }

        await ctx.db.patch(existing._id, {
            app: args.app,
            accountId: args.accountId,
            instrument: args.instrument,
            updatedAt: args.updatedAt,
        })
        return
    }

    await ctx.db.insert("instrument_claims", {
        strategyId: args.strategyId,
        app: args.app,
        accountId: args.accountId,
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
    const structureAliases = getAlpacaStructureAliases(instrument)
    const intentRecord = isRecord(intent) ? intent : undefined
    const conditionAlias = buildPolymarketConditionInstrumentAlias(
        readPolymarketConditionId(readClaimMetadataRecord(intentRecord?.metadata))
    )
    const conditionAliases = conditionAlias !== undefined ? [conditionAlias] : []

    if (!intentRecord || !Array.isArray(intentRecord.legs)) {
        return uniqueInstruments([instrument, ...structureAliases, ...conditionAliases])
    }

    const legInstruments = intentRecord.legs
        .filter(isRecord)
        .map((leg) => typeof leg.instrument === "string" ? leg.instrument : "")

    return uniqueInstruments([instrument, ...structureAliases, ...conditionAliases, ...legInstruments])
}

export function getProviderInstrumentClaimAliases(
    app: VenueApp,
    instrument: string,
    metadata?: unknown
): string[] {
    if (app === "polymarket") {
        const conditionAlias = buildPolymarketConditionInstrumentAlias(
            readPolymarketConditionId(readClaimMetadataRecord(metadata))
        )
        return uniqueInstruments(
            conditionAlias !== undefined ? [instrument, conditionAlias] : [instrument]
        )
    }

    if (app !== "alpaca-options") {
        return uniqueInstruments([instrument])
    }

    return uniqueInstruments([instrument, ...getAlpacaStructureAliases(instrument)])
}

function readClaimMetadataRecord(metadata: unknown): Record<string, unknown> | undefined {
    if (isRecord(metadata)) {
        return metadata
    }

    if (typeof metadata !== "string" || metadata.trim().length === 0) {
        return undefined
    }

    try {
        const parsed = JSON.parse(metadata)
        return isRecord(parsed) ? parsed : undefined
    } catch {
        return undefined
    }
}

export function resolveAlpacaClaimedStructureForProviderLeg(args: {
    instrument: string
    strategyId: string
    claims: Array<{ strategyId: unknown; instrument: string }>
}): {
    instrument: string
    structureType: "iron_condor" | "credit_vertical"
    verticalSpreadType?: "bull_put_credit" | "bear_call_credit"
    underlying: string
    expiration: string
    legs: string[]
} | undefined {
    const normalizedInstrument = args.instrument.trim().toUpperCase()
    const candidates = args.claims
        .filter((claim) => String(claim.strategyId) === args.strategyId)
        .map((claim) => ({
            claim,
            parsed: parseAlpacaStructureInstrument(claim.instrument.trim().toUpperCase()),
        }))
        .filter((entry): entry is {
            claim: { strategyId: unknown; instrument: string }
            parsed: {
                prefix: "IC" | "VS"
                underlying: string
                expiration: string
                legs: string[]
            }
        } => Boolean(entry.parsed?.legs.includes(normalizedInstrument)))
        .sort(compareAlpacaStructureClaims)

    const selected = candidates[0]
    if (!selected) {
        return undefined
    }

    const sameRank = candidates.filter((candidate) =>
        getAlpacaClaimRank(candidate.parsed) === getAlpacaClaimRank(selected.parsed)
    )
    if (sameRank.length > 1) {
        return undefined
    }

    return {
        instrument: selected.claim.instrument.trim().toUpperCase(),
        structureType: selected.parsed.prefix === "IC" ? "iron_condor" : "credit_vertical",
        verticalSpreadType: selected.parsed.prefix === "VS"
            ? selected.claim.instrument.includes("BULL_PUT_CREDIT")
                ? "bull_put_credit"
                : "bear_call_credit"
            : undefined,
        underlying: selected.parsed.underlying,
        expiration: selected.parsed.expiration,
        legs: selected.parsed.legs,
    }
}

function getAlpacaStructureAliases(instrument: string): string[] {
    const normalized = instrument.trim().toUpperCase()

    if (normalized.startsWith("IC:")) {
        return getAlpacaIronCondorAliases(normalized)
    }

    if (normalized.startsWith("VS:")) {
        return getAlpacaVerticalAliases(normalized)
    }

    return []
}

function compareAlpacaStructureClaims(
    left: {
        parsed: {
            prefix: "IC" | "VS"
            legs: string[]
        }
        claim: { instrument: string }
    },
    right: {
        parsed: {
            prefix: "IC" | "VS"
            legs: string[]
        }
        claim: { instrument: string }
    }
): number {
    const rankDifference = getAlpacaClaimRank(right.parsed) - getAlpacaClaimRank(left.parsed)
    if (rankDifference !== 0) {
        return rankDifference
    }

    return left.claim.instrument.localeCompare(right.claim.instrument)
}

function getAlpacaClaimRank(parsed: {
    prefix: "IC" | "VS"
    legs: string[]
}): number {
    if (parsed.prefix === "IC") {
        return 2
    }

    return parsed.legs.length === 2 ? 1 : 0
}

function getAlpacaIronCondorAliases(instrument: string): string[] {
    const parsed = parseAlpacaStructureInstrument(instrument)
    if (!parsed || parsed.prefix !== "IC" || parsed.legs.length !== 4) {
        return []
    }

    const callLegs = parsed.legs.filter((leg) => readAlpacaOptionType(leg) === "C").sort()
    const putLegs = parsed.legs.filter((leg) => readAlpacaOptionType(leg) === "P").sort()
    const aliases: string[] = [...parsed.legs]

    if (callLegs.length === 2) {
        aliases.push(`VS:BEAR_CALL_CREDIT:${parsed.underlying}:${parsed.expiration}:${callLegs.join("|")}`)
    }

    if (putLegs.length === 2) {
        aliases.push(`VS:BULL_PUT_CREDIT:${parsed.underlying}:${parsed.expiration}:${putLegs.join("|")}`)
    }

    return aliases
}

function getAlpacaVerticalAliases(instrument: string): string[] {
    const parsed = parseAlpacaStructureInstrument(instrument)
    return parsed?.prefix === "VS" ? parsed.legs : []
}

function parseAlpacaStructureInstrument(instrument: string): {
    prefix: "IC" | "VS"
    underlying: string
    expiration: string
    legs: string[]
} | undefined {
    const parts = instrument.split(":")
    const prefix = parts[0]

    if (prefix === "IC" && parts.length === 4) {
        return {
            prefix,
            underlying: parts[1] ?? "",
            expiration: parts[2] ?? "",
            legs: splitAlpacaLegs(parts[3]),
        }
    }

    if (prefix === "VS" && parts.length === 5) {
        return {
            prefix,
            underlying: parts[2] ?? "",
            expiration: parts[3] ?? "",
            legs: splitAlpacaLegs(parts[4]),
        }
    }

    return undefined
}

function splitAlpacaLegs(value: string | undefined): string[] {
    if (!value) {
        return []
    }

    return value
        .split("|")
        .map((leg) => leg.trim().toUpperCase())
        .filter((leg) => leg.length > 0)
}

function readAlpacaOptionType(symbol: string): "C" | "P" | undefined {
    const match = symbol.match(/\d{6}([CP])\d{8}$/)
    return match?.[1] === "C" || match?.[1] === "P" ? match[1] : undefined
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

    const appOwnedInstruments = await getOwnedInstrumentsByAppAccount(ctx, strategy.app, strategy.accountId)
    return uniqueInstruments(
        appOwnedInstruments
            .filter((entry) => entry.strategyId === strategyId)
            .map((entry) => entry.instrument)
    )
}

export async function getOwnedInstrumentsByAppAccount(
    ctx: QueryDbCtx,
    app: VenueApp,
    accountId: string
): Promise<Array<{ instrument: string; strategyId: Id<"strategies">; accountId: string }>> {
    const [strategies, claims] = await Promise.all([
        ctx.db
            .query("strategies")
            .withIndex("by_app_account", (q) => q.eq("app", app).eq("accountId", accountId))
            .collect(),
        ctx.db
            .query("instrument_claims")
            .withIndex("by_app_account", (q) => q.eq("app", app).eq("accountId", accountId))
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
    const owned: Array<{ instrument: string; strategyId: Id<"strategies">; accountId: string }> = []
    const orderedStrategies = [...strategies].sort(compareStrategiesForBootstrap)
    for (const strategy of orderedStrategies) {
        const claimed = claimedByStrategy.get(String(strategy._id))
        if (claimed && claimed.length > 0) {
            const claimedInstruments = uniqueInstruments(claimed)
            const conditionAliases = app === "polymarket"
                ? await getPolymarketConditionAliasesForStrategy(ctx, strategy._id, claimedInstruments)
                : []
            for (const instrument of uniqueInstruments([...claimedInstruments, ...conditionAliases])) {
                owned.push({ instrument, strategyId: strategy._id, accountId: strategy.accountId })
            }
            continue
        }

        const positions = await getLatestPositionsForStrategy(ctx, strategy._id)
        const positionInstruments = uniqueInstruments(positions.map((position) => position.instrument))
        const ownedPositionInstruments: string[] = []
        for (const instrument of positionInstruments) {
            if (reservedInstruments.has(instrument)) {
                continue
            }

            owned.push({ instrument, strategyId: strategy._id, accountId: strategy.accountId })
            reservedInstruments.add(instrument)
            ownedPositionInstruments.push(instrument)
        }

        if (app === "polymarket") {
            const conditionAliases = collectPolymarketConditionAliases(positions, ownedPositionInstruments)
            for (const alias of conditionAliases) {
                if (reservedInstruments.has(alias)) {
                    continue
                }

                owned.push({ instrument: alias, strategyId: strategy._id, accountId: strategy.accountId })
                reservedInstruments.add(alias)
            }
        }
    }

    return owned
}

async function getPolymarketConditionAliasesForStrategy(
    ctx: QueryDbCtx,
    strategyId: Id<"strategies">,
    claimedInstruments: string[]
): Promise<string[]> {
    const positions = await getLatestPositionsForStrategy(ctx, strategyId)
    return collectPolymarketConditionAliases(positions, claimedInstruments)
}

function collectPolymarketConditionAliases(
    positions: Array<{ instrument: string; metadata?: unknown }>,
    ownedInstruments: string[]
): string[] {
    const ownedSet = new Set(ownedInstruments)
    const aliases: string[] = []

    for (const position of positions) {
        if (!ownedSet.has(position.instrument)) {
            continue
        }

        for (const alias of getProviderInstrumentClaimAliases("polymarket", position.instrument, position.metadata)) {
            if (alias !== position.instrument) {
                aliases.push(alias)
            }
        }
    }

    return uniqueInstruments(aliases)
}

export async function replacePositionClaims(
    ctx: MutationDbCtx,
    args: {
        strategyId: Id<"strategies">
        app: VenueApp
        accountId: string
        instruments?: string[]
        positionClaims?: Array<{
            instrument: string
            sourceId?: string
        }>
        updatedAt: number
    }
): Promise<void> {
    const fallbackClaims = uniqueInstruments(args.instruments ?? []).map((instrument) => ({
        instrument,
        sourceId: instrument,
    }))
    const requestedClaims = (args.positionClaims ?? [])
        .map((claim) => ({
            instrument: claim.instrument.trim(),
            sourceId: (claim.sourceId ?? claim.instrument).trim(),
        }))
        .filter((claim) => claim.instrument.length > 0 && claim.sourceId.length > 0)
    const nextClaims = requestedClaims.length > 0
        ? requestedClaims
        : fallbackClaims
    const dedupedClaims = new Map<string, { instrument: string; sourceId: string }>()

    for (const claim of nextClaims) {
        dedupedClaims.set(claim.sourceId, claim)
    }

    const nextSourceIdSet = new Set(Array.from(dedupedClaims.keys()))
    const existingClaims = await ctx.db
        .query("instrument_claims")
        .withIndex("by_strategy_source", (q) =>
            q.eq("strategyId", args.strategyId).eq("source", POSITION_CLAIM_SOURCE)
        )
        .collect()

    for (const claim of existingClaims) {
        if (!nextSourceIdSet.has(claim.sourceId)) {
            await ctx.db.delete(claim._id)
        }
    }

    for (const claim of dedupedClaims.values()) {
        await upsertClaim(ctx, {
            strategyId: args.strategyId,
            app: args.app,
            accountId: args.accountId,
            instrument: claim.instrument,
            source: POSITION_CLAIM_SOURCE,
            sourceId: claim.sourceId,
            updatedAt: args.updatedAt,
        })
    }
}

export async function upsertPositionInstrumentClaims(
    ctx: MutationDbCtx,
    args: {
        strategyId: Id<"strategies">
        app: VenueApp
        accountId: string
        instruments: string[]
        updatedAt: number
    }
): Promise<void> {
    for (const instrument of uniqueInstruments(args.instruments)) {
        await upsertClaim(ctx, {
            strategyId: args.strategyId,
            app: args.app,
            accountId: args.accountId,
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
        accountId: string
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
                    accountId: args.accountId,
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
                accountId: args.accountId,
                instruments,
                updatedAt: args.updatedAt,
            })
        }
        return
    }

    await deleteOrderClaims(ctx, args.strategyId, args.orderId)
}

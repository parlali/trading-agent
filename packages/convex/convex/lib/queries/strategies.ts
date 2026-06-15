import { internalQuery, query } from "../../_generated/server"
import { v } from "convex/values"
import { requireServiceToken, requireUserOrServiceToken } from "../authGuards"
import {
    getOwnedInstrumentsByAppAccount,
    getOwnedInstrumentsForStrategy,
} from "../instrumentClaims"
import { venueAppV } from "../validators"

export const getStrategyConfigs = query({
    args: {
        serviceToken: v.string(),
        app: venueAppV,
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        return await ctx.db
            .query("strategies")
            .withIndex("by_app_enabled", (q) =>
                q.eq("app", args.app).eq("enabled", true)
            )
            .collect()
    },
})

export const getAccounts = query({
    args: {
        serviceToken: v.optional(v.string()),
        app: v.optional(venueAppV),
    },
    handler: async (ctx, args) => {
        await requireUserOrServiceToken(ctx, args.serviceToken)

        if (args.app) {
            return await ctx.db
                .query("accounts")
                .withIndex("by_app", (q) => q.eq("app", args.app!))
                .collect()
        }

        return await ctx.db.query("accounts").collect()
    },
})

export const getAccountByAppAndId = query({
    args: {
        serviceToken: v.string(),
        app: venueAppV,
        accountId: v.string(),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        return await ctx.db
            .query("accounts")
            .withIndex("by_app_account", (q) =>
                q.eq("app", args.app).eq("accountId", args.accountId)
            )
            .first()
    },
})

export const getAccountByAppAndIdInternal = internalQuery({
    args: {
        app: venueAppV,
        accountId: v.string(),
    },
    handler: async (ctx, args) => {
        return await ctx.db
            .query("accounts")
            .withIndex("by_app_account", (q) =>
                q.eq("app", args.app).eq("accountId", args.accountId)
            )
            .first()
    },
})

export const getStrategyById = query({
    args: { serviceToken: v.optional(v.string()), id: v.id("strategies") },
    handler: async (ctx, args) => {
        await requireUserOrServiceToken(ctx, args.serviceToken)
        return await ctx.db.get(args.id)
    },
})

export const getAllStrategies = query({
    args: {
        serviceToken: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        await requireUserOrServiceToken(ctx, args.serviceToken)
        return await ctx.db.query("strategies").collect()
    },
})

export const getStrategyMcpToolWhitelist = query({
    args: {
        serviceToken: v.optional(v.string()),
        strategyId: v.id("strategies"),
    },
    handler: async (ctx, args) => {
        await requireUserOrServiceToken(ctx, args.serviceToken)

        return await ctx.db
            .query("strategy_mcp_tool_whitelists")
            .withIndex("by_strategy", (q) => q.eq("strategyId", args.strategyId))
            .first()
    },
})

export const getStrategyOwnedInstruments = query({
    args: { serviceToken: v.string(), strategyId: v.id("strategies") },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        return await getOwnedInstrumentsForStrategy(ctx, args.strategyId)
    },
})

export const getInstrumentClaimsForStrategy = query({
    args: { serviceToken: v.string(), strategyId: v.id("strategies") },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        const claims = await ctx.db
            .query("instrument_claims")
            .withIndex("by_strategy", (q) => q.eq("strategyId", args.strategyId))
            .collect()

        return claims.map((claim) => ({
            instrument: claim.instrument,
        }))
    },
})

export const getStrategyOwnershipScope = query({
    args: { serviceToken: v.string(), strategyId: v.id("strategies") },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)

        const strategy = await ctx.db.get(args.strategyId)
        if (!strategy) {
            return {
                instruments: [],
                positionKeys: [],
                workingOrderIds: [],
            }
        }

        const [
            ownedInstruments,
            claims,
            providerPositions,
            providerWorkingOrders,
            pendingOrders,
            partiallyFilledOrders,
        ] = await Promise.all([
            getOwnedInstrumentsForStrategy(ctx, args.strategyId),
            ctx.db
                .query("instrument_claims")
                .withIndex("by_strategy", (q) => q.eq("strategyId", args.strategyId))
                .collect(),
            ctx.db
                .query("provider_positions")
                .withIndex("by_app_strategy", (q) =>
                    q.eq("app", strategy.app).eq("strategyId", args.strategyId)
                )
                .collect(),
            ctx.db
                .query("provider_working_orders")
                .withIndex("by_app_strategy", (q) =>
                    q.eq("app", strategy.app).eq("strategyId", args.strategyId)
                )
                .collect(),
            ctx.db
                .query("orders")
                .withIndex("by_strategy_status", (q) =>
                    q.eq("strategyId", args.strategyId).eq("status", "pending")
                )
                .collect(),
            ctx.db
                .query("orders")
                .withIndex("by_strategy_status", (q) =>
                    q.eq("strategyId", args.strategyId).eq("status", "partially_filled")
                )
                .collect(),
        ])

        const instruments = new Set(ownedInstruments)
        const positionKeys = new Set<string>()
        const workingOrderIds = new Set<string>()

        for (const claim of claims) {
            instruments.add(claim.instrument)
            if (claim.source === "position" && claim.sourceId !== claim.instrument) {
                positionKeys.add(claim.sourceId)
            }
            if (claim.source === "order") {
                workingOrderIds.add(extractOrderIdFromClaimSourceId(claim.sourceId, claim.instrument))
            }
        }

        for (const position of providerPositions) {
            instruments.add(position.instrument)
            positionKeys.add(position.positionKey)
        }

        for (const order of providerWorkingOrders) {
            instruments.add(order.instrument)
            workingOrderIds.add(order.orderId)
        }

        for (const order of [...pendingOrders, ...partiallyFilledOrders]) {
            instruments.add(order.instrument)
            workingOrderIds.add(order.orderId)
            workingOrderIds.add(order.providerOrderId)
            for (const alias of order.providerOrderAliases ?? []) {
                workingOrderIds.add(alias)
            }
        }

        return {
            instruments: Array.from(instruments).filter(Boolean).sort((left, right) => left.localeCompare(right)),
            positionKeys: Array.from(positionKeys).filter(Boolean).sort((left, right) => left.localeCompare(right)),
            workingOrderIds: Array.from(workingOrderIds).filter(Boolean).sort((left, right) => left.localeCompare(right)),
        }
    },
})

export const getAllOwnedInstrumentsByApp = query({
    args: {
        serviceToken: v.string(),
        app: venueAppV,
        accountId: v.string(),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        return await getOwnedInstrumentsByAppAccount(ctx, args.app, args.accountId)
    },
})

function extractOrderIdFromClaimSourceId(sourceId: string, instrument: string): string {
    const suffix = `:${instrument}`
    if (sourceId.endsWith(suffix)) {
        return sourceId.slice(0, -suffix.length)
    }

    return sourceId
}

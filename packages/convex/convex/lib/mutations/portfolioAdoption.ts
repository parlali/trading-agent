import { v } from "convex/values"
import { mutation } from "../../_generated/server"
import { resolveProviderAdoptionInstruments } from "@valiq-trading/core"
import { requireServiceToken } from "../authGuards"
import { replacePositionClaims } from "../instrumentClaims"
import { venueAppV } from "../validators"
import { listActiveOrdersForApp } from "./portfolioOrders"
import { updateProviderSyncStateFromCurrentRows } from "./portfolioSnapshots"

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
            .withIndex("by_app_account", (q) => q.eq("app", args.app).eq("accountId", strategy.accountId))
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
                .withIndex("by_app_account", (q) => q.eq("app", args.app).eq("accountId", strategy.accountId))
                .collect(),
            ctx.db
                .query("provider_positions")
                .withIndex("by_app_account", (q) => q.eq("app", args.app).eq("accountId", strategy.accountId))
                .collect(),
            ctx.db
                .query("provider_working_orders")
                .withIndex("by_app_account", (q) => q.eq("app", args.app).eq("accountId", strategy.accountId))
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

        await replacePositionClaims(ctx, {
            strategyId: args.strategyId,
            app: args.app,
            accountId: strategy.accountId,
            instruments,
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

        await updateProviderSyncStateFromCurrentRows(ctx, args.app, strategy.accountId, now)

        return {
            adoptedPositions,
            adoptedOrders,
        }
    },
})

import { mutation } from "../../_generated/server";
import { v } from "convex/values";
import { validateStrategyConfig } from "@valiq-trading/core";
import { requireUser, requireServiceToken } from "../authGuards";
const PORTFOLIO_STALE_AFTER_MS = 10 * 60 * 1000;
const venueAppArg = v.union(v.literal("alpaca-options"), v.literal("polymarket"), v.literal("mt5"), v.literal("binance-futures"));
const strategyImportArg = v.object({
    app: venueAppArg,
    name: v.string(),
    enabled: v.boolean(),
    schedule: v.string(),
    policy: v.any(),
    context: v.string(),
});
export const upsertStrategy = mutation({
    args: {
        id: v.optional(v.id("strategies")),
        app: venueAppArg,
        name: v.string(),
        enabled: v.boolean(),
        schedule: v.string(),
        policy: v.any(),
        context: v.string(),
        serviceToken: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        if (args.serviceToken) {
            requireServiceToken(args.serviceToken);
        }
        else {
            await requireUser(ctx);
        }
        const strategy = validateStrategyConfig({
            app: args.app,
            name: args.name,
            enabled: args.enabled,
            schedule: args.schedule,
            policy: args.policy,
            context: args.context,
        });
        const now = Date.now();
        if (args.id) {
            await ctx.db.patch(args.id, {
                app: strategy.app,
                name: strategy.name,
                enabled: strategy.enabled,
                schedule: strategy.schedule,
                policy: strategy.policy,
                context: strategy.context,
                updatedAt: now,
            });
            return args.id;
        }
        return await ctx.db.insert("strategies", {
            app: strategy.app,
            name: strategy.name,
            enabled: strategy.enabled,
            schedule: strategy.schedule,
            policy: strategy.policy,
            context: strategy.context,
            createdAt: now,
            updatedAt: now,
        });
    },
});
export const disableStrategy = mutation({
    args: {
        strategyId: v.id("strategies"),
        serviceToken: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        if (args.serviceToken) {
            requireServiceToken(args.serviceToken);
        }
        else {
            await requireUser(ctx);
        }
        await ctx.db.patch(args.strategyId, { enabled: false });
    },
});
export const deleteStrategy = mutation({
    args: {
        strategyId: v.id("strategies"),
        serviceToken: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        if (args.serviceToken) {
            requireServiceToken(args.serviceToken);
        }
        else {
            await requireUser(ctx);
        }
        const strategy = await ctx.db.get(args.strategyId);
        if (!strategy) {
            throw new Error(`Strategy not found: ${args.strategyId}`);
        }
        const activeRun = await ctx.db
            .query("strategy_runs")
            .withIndex("by_strategy_status", (q) => q.eq("strategyId", args.strategyId).eq("status", "running"))
            .first();
        if (activeRun) {
            throw new Error("Cannot delete a strategy with an active run");
        }
        await assertStrategyDeletionSafe(ctx, strategy);
        return await cascadeDeleteStrategy(ctx, args.strategyId);
    },
});
export const deleteAllStrategies = mutation({
    args: {
        serviceToken: v.string(),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken);
        const deleted = {
            strategies: 0,
            runs: 0,
            agentLogs: 0,
            tradeEvents: 0,
            orders: 0,
            orderTransitions: 0,
            positions: 0,
            instrumentClaims: 0,
            positionSyncs: 0,
            providerPositions: 0,
            providerWorkingOrders: 0,
            providerSyncStates: 0,
            accountSnapshots: 0,
            appHeartbeats: 0,
            manualRunRequests: 0,
            alerts: 0,
        };
        const existingStrategies = await ctx.db.query("strategies").collect();
        for (const strategy of existingStrategies) {
            await assertStrategyDeletionSafe(ctx, strategy);
        }
        for (const strategy of existingStrategies) {
            const result = await cascadeDeleteStrategy(ctx, strategy._id);
            deleted.strategies++;
            deleted.runs += result.runs;
            deleted.agentLogs += result.agentLogs;
            deleted.tradeEvents += result.tradeEvents;
            deleted.orders += result.orders;
            deleted.orderTransitions += result.orderTransitions;
            deleted.positions += result.positions;
            deleted.instrumentClaims += result.instrumentClaims;
            deleted.positionSyncs += result.positionSyncs;
            deleted.providerPositions += result.providerPositions;
            deleted.providerWorkingOrders += result.providerWorkingOrders;
            deleted.providerSyncStates += result.providerSyncStates;
            deleted.accountSnapshots += result.accountSnapshots;
            deleted.appHeartbeats += result.appHeartbeats;
            deleted.manualRunRequests += result.manualRunRequests;
            deleted.alerts += result.alerts;
        }
        return deleted;
    },
});
export const triggerManualRun = mutation({
    args: {
        strategyId: v.id("strategies"),
    },
    handler: async (ctx, args) => {
        await requireUser(ctx);
        const strategy = await ctx.db.get(args.strategyId);
        if (!strategy) {
            throw new Error(`Strategy not found: ${args.strategyId}`);
        }
        const existing = await ctx.db
            .query("manual_run_requests")
            .withIndex("by_strategy", (q) => q.eq("strategyId", args.strategyId))
            .first();
        if (existing) {
            return existing._id;
        }
        return await ctx.db.insert("manual_run_requests", {
            strategyId: args.strategyId,
            app: strategy.app,
            requestedAt: Date.now(),
        });
    },
});
async function cascadeDeleteRun(ctx, runId) {
    let agentLogs = 0;
    let tradeEvents = 0;
    let orders = 0;
    let orderTransitions = 0;
    const logs = await ctx.db
        .query("agent_logs")
        .withIndex("by_run", (q) => q.eq("runId", runId))
        .collect();
    for (const log of logs) {
        await ctx.db.delete(log._id);
        agentLogs++;
    }
    const events = await ctx.db
        .query("trade_events")
        .withIndex("by_run", (q) => q.eq("runId", runId))
        .collect();
    for (const event of events) {
        await ctx.db.delete(event._id);
        tradeEvents++;
    }
    const runOrders = await ctx.db
        .query("orders")
        .withIndex("by_run", (q) => q.eq("runId", runId))
        .collect();
    for (const order of runOrders) {
        const transitions = await ctx.db
            .query("order_transitions")
            .withIndex("by_order_sequence", (q) => q.eq("orderId", order.orderId))
            .collect();
        for (const t of transitions) {
            await ctx.db.delete(t._id);
            orderTransitions++;
        }
        await ctx.db.delete(order._id);
        orders++;
    }
    await ctx.db.delete(runId);
    return {
        agentLogs,
        tradeEvents,
        orders,
        orderTransitions,
    };
}
async function cascadeDeleteStrategy(ctx, strategyId) {
    const strategy = await ctx.db.get(strategyId);
    if (!strategy) {
        throw new Error(`Strategy not found: ${strategyId}`);
    }
    let runs = 0;
    let agentLogs = 0;
    let tradeEvents = 0;
    let orders = 0;
    let orderTransitions = 0;
    let positions = 0;
    let instrumentClaims = 0;
    let positionSyncs = 0;
    let providerPositions = 0;
    let providerWorkingOrders = 0;
    let providerSyncStates = 0;
    let accountSnapshots = 0;
    let appHeartbeats = 0;
    let manualRunRequests = 0;
    let alerts = 0;
    const strategyRuns = await ctx.db
        .query("strategy_runs")
        .withIndex("by_strategy", (q) => q.eq("strategyId", strategyId))
        .collect();
    for (const run of strategyRuns) {
        const deleted = await cascadeDeleteRun(ctx, run._id);
        runs++;
        agentLogs += deleted.agentLogs;
        tradeEvents += deleted.tradeEvents;
        orders += deleted.orders;
        orderTransitions += deleted.orderTransitions;
    }
    const strategyPositions = await ctx.db
        .query("positions")
        .withIndex("by_strategy", (q) => q.eq("strategyId", strategyId))
        .collect();
    for (const position of strategyPositions) {
        await ctx.db.delete(position._id);
        positions++;
    }
    const strategyClaims = await ctx.db
        .query("instrument_claims")
        .withIndex("by_strategy", (q) => q.eq("strategyId", strategyId))
        .collect();
    for (const claim of strategyClaims) {
        await ctx.db.delete(claim._id);
        instrumentClaims++;
    }
    const strategySyncs = await ctx.db
        .query("position_syncs")
        .withIndex("by_strategy_synced_at", (q) => q.eq("strategyId", strategyId))
        .collect();
    for (const sync of strategySyncs) {
        await ctx.db.delete(sync._id);
        positionSyncs++;
    }
    const strategyProviderPositions = await ctx.db
        .query("provider_positions")
        .withIndex("by_app_strategy", (q) => q.eq("app", strategy.app).eq("strategyId", strategyId))
        .collect();
    for (const position of strategyProviderPositions) {
        await ctx.db.delete(position._id);
        providerPositions++;
    }
    const strategyProviderWorkingOrders = await ctx.db
        .query("provider_working_orders")
        .withIndex("by_app_strategy", (q) => q.eq("app", strategy.app).eq("strategyId", strategyId))
        .collect();
    for (const order of strategyProviderWorkingOrders) {
        await ctx.db.delete(order._id);
        providerWorkingOrders++;
    }
    const strategyManualRunRequests = await ctx.db
        .query("manual_run_requests")
        .withIndex("by_strategy", (q) => q.eq("strategyId", strategyId))
        .collect();
    for (const request of strategyManualRunRequests) {
        await ctx.db.delete(request._id);
        manualRunRequests++;
    }
    const strategyAlerts = (await ctx.db.query("alerts").collect()).filter((alert) => alert.strategyId === strategyId);
    for (const alert of strategyAlerts) {
        await ctx.db.delete(alert._id);
        alerts++;
    }
    const appStrategies = await ctx.db
        .query("strategies")
        .withIndex("by_app", (q) => q.eq("app", strategy.app))
        .collect();
    const isLastStrategyForApp = appStrategies.length === 1;
    if (isLastStrategyForApp) {
        const remainingProviderPositions = await ctx.db
            .query("provider_positions")
            .withIndex("by_app", (q) => q.eq("app", strategy.app))
            .collect();
        for (const position of remainingProviderPositions) {
            await ctx.db.delete(position._id);
            providerPositions++;
        }
        const remainingProviderWorkingOrders = await ctx.db
            .query("provider_working_orders")
            .withIndex("by_app", (q) => q.eq("app", strategy.app))
            .collect();
        for (const order of remainingProviderWorkingOrders) {
            await ctx.db.delete(order._id);
            providerWorkingOrders++;
        }
        const providerSyncState = await ctx.db
            .query("provider_sync_state")
            .withIndex("by_app", (q) => q.eq("app", strategy.app))
            .first();
        if (providerSyncState) {
            await ctx.db.delete(providerSyncState._id);
            providerSyncStates++;
        }
        const snapshots = await ctx.db
            .query("account_snapshots")
            .withIndex("by_app", (q) => q.eq("app", strategy.app))
            .collect();
        for (const snapshot of snapshots) {
            await ctx.db.delete(snapshot._id);
            accountSnapshots++;
        }
        const heartbeat = await ctx.db
            .query("app_heartbeats")
            .withIndex("by_app", (q) => q.eq("app", strategy.app))
            .first();
        if (heartbeat) {
            await ctx.db.delete(heartbeat._id);
            appHeartbeats++;
        }
    }
    await ctx.db.delete(strategyId);
    return {
        runs,
        agentLogs,
        tradeEvents,
        orders,
        orderTransitions,
        positions,
        instrumentClaims,
        positionSyncs,
        providerPositions,
        providerWorkingOrders,
        providerSyncStates,
        accountSnapshots,
        appHeartbeats,
        manualRunRequests,
        alerts,
    };
}
export const stopRun = mutation({
    args: { runId: v.id("strategy_runs") },
    handler: async (ctx, args) => {
        await requireUser(ctx);
        const run = await ctx.db.get(args.runId);
        if (!run)
            throw new Error("Run not found");
        if (run.status !== "running")
            throw new Error("Run is not active");
        await ctx.db.patch(args.runId, {
            status: "failed",
            error: "Manually stopped by user",
            endedAt: Date.now(),
        });
    },
});
export const deleteRun = mutation({
    args: { runId: v.id("strategy_runs") },
    handler: async (ctx, args) => {
        await requireUser(ctx);
        const run = await ctx.db.get(args.runId);
        if (!run)
            throw new Error("Run not found");
        await cascadeDeleteRun(ctx, args.runId);
    },
});
export const deleteAllRuns = mutation({
    args: {
        strategyId: v.id("strategies"),
        serviceToken: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        if (args.serviceToken) {
            requireServiceToken(args.serviceToken);
        }
        else {
            await requireUser(ctx);
        }
        const runs = await ctx.db
            .query("strategy_runs")
            .withIndex("by_strategy", (q) => q.eq("strategyId", args.strategyId))
            .collect();
        for (const run of runs) {
            await cascadeDeleteRun(ctx, run._id);
        }
        return { deleted: runs.length };
    },
});
export const replaceAllStrategies = mutation({
    args: {
        serviceToken: v.string(),
        strategies: v.array(strategyImportArg),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken);
        const strategies = args.strategies.map((strategy) => validateStrategyConfig(strategy));
        const existingStrategies = await ctx.db.query("strategies").collect();
        for (const strategy of existingStrategies) {
            await assertStrategyDeletionSafe(ctx, strategy);
        }
        const deleted = {
            strategies: 0,
            runs: 0,
            agentLogs: 0,
            tradeEvents: 0,
            orders: 0,
            orderTransitions: 0,
            positions: 0,
            instrumentClaims: 0,
            positionSyncs: 0,
            providerPositions: 0,
            providerWorkingOrders: 0,
            providerSyncStates: 0,
            accountSnapshots: 0,
            appHeartbeats: 0,
            manualRunRequests: 0,
            alerts: 0,
        };
        const runs = await ctx.db.query("strategy_runs").collect();
        for (const run of runs) {
            const result = await cascadeDeleteRun(ctx, run._id);
            deleted.runs++;
            deleted.agentLogs += result.agentLogs;
            deleted.tradeEvents += result.tradeEvents;
            deleted.orders += result.orders;
            deleted.orderTransitions += result.orderTransitions;
        }
        for (const strategy of existingStrategies) {
            const result = await cascadeDeleteStrategy(ctx, strategy._id);
            deleted.strategies++;
            deleted.runs += result.runs;
            deleted.agentLogs += result.agentLogs;
            deleted.tradeEvents += result.tradeEvents;
            deleted.orders += result.orders;
            deleted.orderTransitions += result.orderTransitions;
            deleted.positions += result.positions;
            deleted.instrumentClaims += result.instrumentClaims;
            deleted.positionSyncs += result.positionSyncs;
            deleted.providerPositions += result.providerPositions;
            deleted.providerWorkingOrders += result.providerWorkingOrders;
            deleted.providerSyncStates += result.providerSyncStates;
            deleted.accountSnapshots += result.accountSnapshots;
            deleted.appHeartbeats += result.appHeartbeats;
            deleted.manualRunRequests += result.manualRunRequests;
            deleted.alerts += result.alerts;
        }
        const now = Date.now();
        for (const strategy of strategies) {
            await ctx.db.insert("strategies", {
                ...strategy,
                createdAt: now,
                updatedAt: now,
            });
        }
        return {
            importedStrategies: strategies.length,
            deleted,
        };
    },
});
async function assertStrategyDeletionSafe(ctx, strategy) {
    const [activeRun, providerState, trackedPositions, trackedWorkingOrders, pendingOrders, partiallyFilledOrders] = await Promise.all([
        ctx.db
            .query("strategy_runs")
            .withIndex("by_strategy_status", (q) => q.eq("strategyId", strategy._id).eq("status", "running"))
            .first(),
        ctx.db
            .query("provider_sync_state")
            .withIndex("by_app", (q) => q.eq("app", strategy.app))
            .first(),
        ctx.db
            .query("provider_positions")
            .withIndex("by_app_strategy", (q) => q.eq("app", strategy.app).eq("strategyId", strategy._id))
            .collect(),
        ctx.db
            .query("provider_working_orders")
            .withIndex("by_app_strategy", (q) => q.eq("app", strategy.app).eq("strategyId", strategy._id))
            .collect(),
        ctx.db
            .query("orders")
            .withIndex("by_strategy_status", (q) => q.eq("strategyId", strategy._id).eq("status", "pending"))
            .collect(),
        ctx.db
            .query("orders")
            .withIndex("by_strategy_status", (q) => q.eq("strategyId", strategy._id).eq("status", "partially_filled"))
            .collect(),
    ]);
    if (activeRun) {
        throw new Error("Cannot delete a strategy with an active run");
    }
    if (providerState &&
        (providerState.driftDetected ||
            providerState.providerStatus !== "healthy" ||
            isPortfolioStateStale(providerState.lastVerifiedAt))) {
        throw new Error(`Cannot delete strategy while ${strategy.app} provider ownership is stale or drifted. Run the backend-admin reset flow after operator review.`);
    }
    if (trackedPositions.length > 0 || trackedWorkingOrders.length > 0) {
        throw new Error(`Cannot delete strategy with live provider-tracked exposure or working orders. Run the backend-admin reset flow first.`);
    }
    if (pendingOrders.length > 0 || partiallyFilledOrders.length > 0) {
        throw new Error("Cannot delete strategy with pending or partially filled orders in Convex state. Run the backend-admin reset flow first.");
    }
}
function isPortfolioStateStale(lastVerifiedAt) {
    if (!lastVerifiedAt) {
        return false;
    }
    return Date.now() - lastVerifiedAt > PORTFOLIO_STALE_AFTER_MS;
}

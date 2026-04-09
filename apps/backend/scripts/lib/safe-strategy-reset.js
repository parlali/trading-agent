import { validatePolicy, } from "@valiq-trading/core";
import { AlpacaPlugin } from "../../src/plugins/alpaca";
import { BinancePlugin } from "../../src/plugins/binance";
import { MT5Plugin } from "../../src/plugins/mt5";
import { PolymarketPlugin } from "../../src/plugins/polymarket";
const RESET_PLUGINS = {
    "alpaca-options": new AlpacaPlugin(),
    "binance-futures": new BinancePlugin(),
    "polymarket": new PolymarketPlugin(),
    "mt5": new MT5Plugin(),
};
export async function resetStrategySafely(client, strategyId) {
    const strategy = await client.getStrategyById(strategyId);
    if (!strategy) {
        throw new Error(`Strategy not found: ${strategyId}`);
    }
    const trackedPositions = await client.getPortfolioPositions(strategy.app, strategy._id);
    const trackedOrders = await client.getPortfolioPendingOrders(strategy.app, strategy._id);
    const freshness = await getFreshness(client, strategy.app);
    assertResetPreconditions(strategy, freshness, trackedPositions, trackedOrders);
    const activeRun = await client.getActiveRun(strategy._id);
    if (activeRun) {
        throw new Error("Cannot reset a strategy with an active run");
    }
    await client.disableStrategy(strategy._id);
    const { venue, venueName } = await createVenue(strategy, client);
    const cancelledOrders = await cancelTrackedOrders(venue, trackedOrders);
    const closedPositions = await closeTrackedPositions(venue, trackedPositions);
    await reconcileAndVerifyReset(client, strategy, venue, venueName);
    const deleted = await client.deleteStrategy(strategy._id);
    return {
        strategy,
        deleted,
        cancelledOrders,
        closedPositions,
    };
}
function assertResetPreconditions(strategy, freshness, trackedPositions, trackedOrders) {
    const requiresHealthyProviderState = (freshness?.lastVerifiedAt ?? 0) > 0 ||
        trackedPositions.length > 0 ||
        trackedOrders.length > 0;
    if (requiresHealthyProviderState &&
        (!freshness ||
            freshness.stale ||
            freshness.driftDetected ||
            freshness.providerStatus !== "healthy")) {
        throw new Error(`Refusing to reset ${strategy.name}: ${strategy.app} provider ownership is stale or drifted. Resolve venue ownership manually before retrying.`);
    }
}
async function createVenue(strategy, client) {
    const plugin = RESET_PLUGINS[strategy.app];
    if (!plugin) {
        throw new Error(`No backend reset plugin registered for ${strategy.app}`);
    }
    const policy = validatePolicy(strategy.app, strategy.policy);
    const secretKeys = new Set([
        ...plugin.resolveSecretKeys(),
        ...(plugin.resolveAdditionalSecretKeys?.(policy) ?? []),
    ]);
    const secrets = await client.resolveSecrets(Array.from(secretKeys));
    return {
        venue: plugin.createVenueAdapter(policy, secrets),
        venueName: plugin.venueName,
    };
}
async function cancelTrackedOrders(venue, orders) {
    let cancelled = 0;
    for (const order of orders) {
        try {
            const result = await venue.cancelOrder(order.orderId);
            if (result.status === "cancelled" || result.status === "filled") {
                cancelled++;
            }
        }
        catch { }
    }
    return cancelled;
}
async function closeTrackedPositions(venue, positions) {
    let closed = 0;
    for (const position of positions) {
        try {
            const result = await venue.closePosition(position.instrument);
            if (result.status === "filled" || result.status === "pending" || result.status === "partially_filled") {
                closed++;
            }
        }
        catch { }
    }
    return closed;
}
async function reconcileAndVerifyReset(client, strategy, venue, venueName) {
    const [accountState, positions, workingOrders] = await Promise.all([
        venue.getAccountState(),
        venue.getPositions(),
        venue.getWorkingOrders ? venue.getWorkingOrders() : Promise.resolve([]),
    ]);
    await client.reconcileProviderPortfolio(strategy.app, venueName, "periodic_sync", accountState, positions, workingOrders);
    const [freshness, remainingPositions, remainingOrders] = await Promise.all([
        getFreshness(client, strategy.app),
        client.getPortfolioPositions(strategy.app, strategy._id),
        client.getPortfolioPendingOrders(strategy.app, strategy._id),
    ]);
    if (!freshness || freshness.stale || freshness.driftDetected || freshness.providerStatus !== "healthy") {
        throw new Error(`Reset verification failed for ${strategy.name}: ${strategy.app} provider ownership is stale or drifted after cleanup.`);
    }
    if (remainingPositions.length > 0 || remainingOrders.length > 0) {
        throw new Error(`Reset verification failed for ${strategy.name}: ${remainingPositions.length} provider position(s) and ${remainingOrders.length} working order(s) still remain.`);
    }
}
async function getFreshness(client, app) {
    const rows = await client.getPortfolioFreshness(app);
    return rows[0] ?? null;
}

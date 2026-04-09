import { DuckDuckGoSearchProvider } from "@valiq-trading/agent";
import { createKillSwitchChecker, createLogger, } from "@valiq-trading/core";
import { createTradingBackendClient, } from "@valiq-trading/convex";
import { AlpacaPlugin } from "./plugins/alpaca";
import { PolymarketPlugin } from "./plugins/polymarket";
import { MT5Plugin } from "./plugins/mt5";
export const APP_NAME = "backend";
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const MANUAL_RUN_POLL_INTERVAL_MS = 5_000;
export const PERIODIC_SYNC_INTERVAL_MS = 5 * 60 * 1000;
export function requireEnv(name) {
    const value = Bun.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}
export const healthState = {
    ready: false,
    startedAt: Date.now(),
    strategyCount: 0,
    venues: {},
};
export const logger = createLogger({ app: APP_NAME });
export const convexUrl = requireEnv("CONVEX_URL");
export const backendServiceToken = requireEnv("BACKEND_SERVICE_TOKEN");
export const healthPort = Number(Bun.env.HEALTH_PORT ?? 3100);
export const backend = createTradingBackendClient({
    url: convexUrl,
    machineAuth: {
        serviceToken: backendServiceToken,
    },
});
export const searchProvider = new DuckDuckGoSearchProvider();
export const plugins = {
    "alpaca-options": new AlpacaPlugin(),
    "polymarket": new PolymarketPlugin(),
    "mt5": new MT5Plugin(),
};
export let resolvedSecrets = {};
export function setResolvedSecrets(secrets) {
    resolvedSecrets = secrets;
}
export let heartbeatTimer = null;
export function setHeartbeatTimer(timer) {
    heartbeatTimer = timer;
}
export let manualRunPollTimer = null;
export function setManualRunPollTimer(timer) {
    manualRunPollTimer = timer;
}
export let manualRunPollInFlight = false;
export function setManualRunPollInFlight(value) {
    manualRunPollInFlight = value;
}
export let periodicSyncTimer = null;
export function setPeriodicSyncTimer(timer) {
    periodicSyncTimer = timer;
}
export let periodicSyncInFlight = false;
export function setPeriodicSyncInFlight(value) {
    periodicSyncInFlight = value;
}
export const killSwitchCheckers = {
    "alpaca-options": createKillSwitchChecker({
        appName: "alpaca-options",
        backend,
        logger,
    }),
    "polymarket": createKillSwitchChecker({
        appName: "polymarket",
        backend,
        logger,
    }),
    "mt5": createKillSwitchChecker({
        appName: "mt5",
        backend,
        logger,
    }),
};
export const syncStrategies = {};
export const ALL_APPS = ["alpaca-options", "polymarket", "mt5"];

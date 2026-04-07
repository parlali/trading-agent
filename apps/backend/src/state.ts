import { DuckDuckGoSearchProvider } from "@valiq-trading/agent"
import {
    createAccountSnapshotPersister,
    createKillSwitchChecker,
    createLogger,
    type App,
} from "@valiq-trading/core"
import {
    createTradingBackendClient,
    type StoredStrategy,
} from "@valiq-trading/convex"
import { AlpacaPlugin } from "./plugins/alpaca"
import { PolymarketPlugin } from "./plugins/polymarket"
import { MT5Plugin } from "./plugins/mt5"
import { BinancePlugin } from "./plugins/binance"
import type { HealthState, VenueApp, VenuePlugin } from "./types"

export const APP_NAME: App = "backend"
export const HEARTBEAT_INTERVAL_MS = 30_000
export const MANUAL_RUN_POLL_INTERVAL_MS = 5_000
export const PERIODIC_SYNC_INTERVAL_MS = 5 * 60 * 1000

declare const Bun: {
    env: Record<string, string | undefined>
    serve(config: {
        port: number
        fetch(request: Request): Response | Promise<Response>
    }): unknown
}

declare const process: {
    on(event: string, listener: () => void): void
    exit(code?: number): void
}

export function requireEnv(name: string): string {
    const value = Bun.env[name]
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`)
    }
    return value
}

export const healthState: HealthState = {
    ready: false,
    startedAt: Date.now(),
    strategyCount: 0,
    venues: {},
}

export const logger = createLogger({ app: APP_NAME })
export const convexUrl = requireEnv("CONVEX_URL")
export const backendServiceToken = requireEnv("BACKEND_SERVICE_TOKEN")
export const healthPort = Number(Bun.env.HEALTH_PORT ?? 3100)
export const backend = createTradingBackendClient({
    url: convexUrl,
    machineAuth: {
        serviceToken: backendServiceToken,
    },
})
export const searchProvider = new DuckDuckGoSearchProvider()

export const plugins: Record<VenueApp, VenuePlugin> = {
    "alpaca-options": new AlpacaPlugin(),
    "polymarket": new PolymarketPlugin(),
    "mt5": new MT5Plugin(),
    "binance-futures": new BinancePlugin(),
}

export let resolvedSecrets: Record<string, string | null> = {}
export function setResolvedSecrets(secrets: Record<string, string | null>): void {
    resolvedSecrets = secrets
}

export let heartbeatTimer: ReturnType<typeof setInterval> | null = null
export function setHeartbeatTimer(timer: ReturnType<typeof setInterval> | null): void {
    heartbeatTimer = timer
}

export let manualRunPollTimer: ReturnType<typeof setInterval> | null = null
export function setManualRunPollTimer(timer: ReturnType<typeof setInterval> | null): void {
    manualRunPollTimer = timer
}

export let manualRunPollInFlight = false
export function setManualRunPollInFlight(value: boolean): void {
    manualRunPollInFlight = value
}

export let periodicSyncTimer: ReturnType<typeof setInterval> | null = null
export function setPeriodicSyncTimer(timer: ReturnType<typeof setInterval> | null): void {
    periodicSyncTimer = timer
}

export let periodicSyncInFlight = false
export function setPeriodicSyncInFlight(value: boolean): void {
    periodicSyncInFlight = value
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
    "binance-futures": createKillSwitchChecker({
        appName: "binance-futures",
        backend,
        logger,
    }),
} as const

export const accountSnapshotPersisters = {
    "alpaca-options": createAccountSnapshotPersister({
        appName: "alpaca-options",
        venueName: "alpaca",
        backend,
        logger,
    }),
    "polymarket": createAccountSnapshotPersister({
        appName: "polymarket",
        venueName: "polymarket",
        backend,
        logger,
    }),
    "mt5": createAccountSnapshotPersister({
        appName: "mt5",
        venueName: "mt5",
        backend,
        logger,
    }),
    "binance-futures": createAccountSnapshotPersister({
        appName: "binance-futures",
        venueName: "binance-futures",
        backend,
        logger,
    }),
} as const

export interface SyncStrategyEntry {
    strategy: StoredStrategy
    policy: Record<string, unknown>
    secrets: Record<string, string | null>
}

export const syncStrategies: Partial<Record<VenueApp, SyncStrategyEntry[]>> = {}

export const ALL_APPS: VenueApp[] = ["alpaca-options", "polymarket", "mt5", "binance-futures"]

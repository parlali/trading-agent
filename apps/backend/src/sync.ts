import {
    DEFAULT_STALE_RUN_TIMEOUT_MS,
    type Scheduler,
} from "@valiq-trading/core"
import {
    PERIODIC_SYNC_INTERVAL_MS,
    ALL_APPS,
    backend,
    healthState,
    logger,
    plugins,
    syncStrategies,
    periodicSyncInFlight,
    periodicSyncTimer,
    setPeriodicSyncInFlight,
    setPeriodicSyncTimer,
} from "./state"
import { reconcileProviderPortfolio, getProviderSyncEntry, recordProviderSyncFailure } from "./provider-sync"
import { registerStrategyWithScheduler } from "./scheduler"
import type { VenueApp } from "./types"

export async function performStartupSync(): Promise<void> {
    logger.info("Performing startup sync for validated venues")

    for (const app of ALL_APPS) {
        if (!healthState.venues[app]?.validated) {
            logger.warn(`Skipping startup sync for ${app}: environment not validated`)
            continue
        }

        const entry = getProviderSyncEntry(app)
        if (!entry) {
            logger.info("Skipping startup sync for app with no registered strategies", { app })
            continue
        }

        try {
            const plugin = plugins[app]
            const venue = plugin.createVenueAdapter(entry.policy, entry.secrets)
            const result = await reconcileProviderPortfolio({
                app,
                venueName: plugin.venueName,
                source: "startup_sync",
                venue,
            })

            await backend.reportHeartbeat(app, result.driftDetected ? "degraded" : "healthy", {
                source: "startup_sync",
                positionCount: result.positions.length,
                pendingOrderCount: result.workingOrders.length,
                balance: result.accountState.balance,
                equity: result.accountState.equity,
                driftDetected: result.driftDetected,
                driftSummary: result.driftSummary,
            })

            logger.info("Startup provider sync completed", {
                app,
                positionCount: result.positions.length,
                pendingOrderCount: result.workingOrders.length,
                balance: result.accountState.balance,
                equity: result.accountState.equity,
                driftDetected: result.driftDetected,
            })
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.error("Startup provider sync failed", {
                app,
                error: message,
            })

            await recordProviderSyncFailure(app, message)

            await backend.reportHeartbeat(app, "degraded", {
                app,
                error: message,
                source: "startup_sync",
            })
        }
    }
}

async function reconcileStrategies(scheduler: Scheduler): Promise<void> {
    const registered = new Set(scheduler.getRegisteredStrategies())

    for (const app of ALL_APPS) {
        const enabledStrategies = await backend.getStrategyConfigs(app)
        const enabledIds = new Set(enabledStrategies.map((strategy) => strategy._id))

        const currentEntries = syncStrategies[app] ?? []
        for (const entry of currentEntries) {
            if (!enabledIds.has(entry.strategy._id)) {
                scheduler.unregister(entry.strategy._id)
                logger.info("Unregistered disabled strategy", {
                    strategyId: entry.strategy._id,
                    name: entry.strategy.name,
                    app,
                })
            }
        }

        syncStrategies[app] = currentEntries.filter((entry) => enabledIds.has(entry.strategy._id))

        for (const strategy of enabledStrategies) {
            if (!registered.has(strategy._id)) {
                await registerStrategyWithScheduler(scheduler, app, strategy)
                logger.info("Registered newly enabled strategy", {
                    strategyId: strategy._id,
                    name: strategy.name,
                    app,
                })
            }
        }

        healthState.strategyCount = scheduler.getRegisteredStrategies().length
    }
}

export function startPeriodicSync(scheduler: Scheduler): void {
    setPeriodicSyncTimer(setInterval(async () => {
        if (periodicSyncInFlight) {
            return
        }

        setPeriodicSyncInFlight(true)

        try {
            const recoveredRuns = await backend.recoverStaleRunningRuns(DEFAULT_STALE_RUN_TIMEOUT_MS)
            if (recoveredRuns > 0) {
                logger.warn("Recovered stale runs during periodic sync", {
                    recoveredRuns,
                })
            }
            await reconcileStrategies(scheduler)
            await performPeriodicSync()
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.error("Periodic sync iteration failed", { error: message })
        } finally {
            setPeriodicSyncInFlight(false)
        }
    }, PERIODIC_SYNC_INTERVAL_MS))
}

export function stopPeriodicSync(): void {
    if (periodicSyncTimer) {
        clearInterval(periodicSyncTimer)
        setPeriodicSyncTimer(null)
    }
}

export async function performPeriodicSync(): Promise<void> {
    for (const app of ALL_APPS) {
        if (!healthState.venues[app]?.validated) {
            continue
        }

        const entry = getProviderSyncEntry(app)
        if (!entry) {
            continue
        }

        try {
            const plugin = plugins[app]
            const venue = plugin.createVenueAdapter(entry.policy, entry.secrets)
            const result = await reconcileProviderPortfolio({
                app,
                venueName: plugin.venueName,
                source: "periodic_sync",
                venue,
            })

            await backend.reportHeartbeat(app, result.driftDetected ? "degraded" : "healthy", {
                source: "periodic_sync",
                positionCount: result.positions.length,
                pendingOrderCount: result.workingOrders.length,
                balance: result.accountState.balance,
                equity: result.accountState.equity,
                driftDetected: result.driftDetected,
                driftSummary: result.driftSummary,
            })
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.error("Periodic provider sync failed", {
                app,
                error: message,
            })

            await recordProviderSyncFailure(app, message)

            await backend.reportHeartbeat(app, "degraded", {
                error: message,
                source: "periodic_sync",
            })

            await backend.createAlert({
                app,
                severity: "warning",
                message: `Periodic provider sync failed for ${app}: ${message}`,
            })
        }
    }
}

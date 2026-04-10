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
import { getRequiredVenueApps } from "./required-apps"
import { resolveAllSecrets, validateAllEnvironments } from "./plugins/init"
import { reconcileProviderPortfolio, getProviderSyncConfig, recordProviderSyncFailure } from "./provider-sync"
import {
    registerStrategyWithScheduler,
    resolveStrategyRuntimeState,
    syncStrategyEntryChanged,
    upsertSyncStrategyEntry,
} from "./scheduler"

export async function performStartupSync(): Promise<void> {
    logger.info("Performing startup sync for validated venues")

    const requiredApps = getRequiredVenueApps(
        ALL_APPS,
        syncStrategies,
        await backend.getPortfolioFreshness()
    )

    for (const app of requiredApps) {
        if (!healthState.venues[app]?.validated) {
            logger.warn(`Skipping startup sync for ${app}: environment not validated`)
            continue
        }

        try {
            const plugin = plugins[app]
            if (!plugin) continue
            const syncConfig = getProviderSyncConfig(app)
            const venue = plugin.createVenueAdapter(syncConfig.policy, syncConfig.secrets)
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

export async function reconcileStrategies(scheduler: Scheduler): Promise<void> {
    await resolveAllSecrets()

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
                continue
            }

            const currentEntry = syncStrategies[app]?.find(
                (entry) => entry.strategy._id === strategy._id
            )
            const nextEntry = await resolveStrategyRuntimeState(app, strategy)

            if (!currentEntry) {
                upsertSyncStrategyEntry(app, nextEntry)
                logger.info("Restored missing in-memory runtime state for registered strategy", {
                    strategyId: strategy._id,
                    name: strategy.name,
                    app,
                })
                continue
            }

            if (!syncStrategyEntryChanged(currentEntry, nextEntry)) {
                continue
            }

            upsertSyncStrategyEntry(app, nextEntry)

            if (currentEntry.strategy.schedule !== nextEntry.strategy.schedule) {
                await registerStrategyWithScheduler(scheduler, app, strategy)
                logger.info("Refreshed registered strategy after schedule change", {
                    strategyId: strategy._id,
                    name: strategy.name,
                    app,
                    previousSchedule: currentEntry.strategy.schedule,
                    nextSchedule: nextEntry.strategy.schedule,
                })
                continue
            }

            logger.info("Refreshed registered strategy runtime state", {
                strategyId: strategy._id,
                name: strategy.name,
                app,
            })
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
            await validateAllEnvironments(ALL_APPS)
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
    const requiredApps = getRequiredVenueApps(
        ALL_APPS,
        syncStrategies,
        await backend.getPortfolioFreshness()
    )

    for (const app of requiredApps) {
        if (!healthState.venues[app]?.validated) {
            continue
        }

        try {
            const plugin = plugins[app]
            if (!plugin) continue
            const syncConfig = getProviderSyncConfig(app)
            const venue = plugin.createVenueAdapter(syncConfig.policy, syncConfig.secrets)
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

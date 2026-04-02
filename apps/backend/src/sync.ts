import { filterPositionsByOwnership, type Scheduler } from "@valiq-trading/core"
import {
    PERIODIC_SYNC_INTERVAL_MS,
    ALL_APPS,
    backend,
    healthState,
    logger,
    plugins,
    syncStrategies,
    accountSnapshotPersisters,
    periodicSyncInFlight,
    periodicSyncTimer,
    setPeriodicSyncInFlight,
    setPeriodicSyncTimer,
} from "./state"
import { registerStrategyWithScheduler } from "./scheduler"
import type { VenueApp } from "./types"

export async function performStartupSync(): Promise<void> {
    logger.info("Performing startup sync for validated venues")

    for (const [appKey, entries] of Object.entries(syncStrategies)) {
        const app = appKey as VenueApp
        const plugin = plugins[app]

        if (!healthState.venues[app]?.validated) {
            logger.warn(`Skipping startup sync for ${app}: environment not validated`)
            continue
        }

        for (const entry of entries) {
            try {
                const venue = plugin.createVenueAdapter(entry.policy, entry.secrets)
                const accountState = await venue.getAccountState()
                await accountSnapshotPersisters[app](accountState)

                const ownedInstrumentsList = await backend.getStrategyOwnedInstruments(entry.strategy._id)
                const ownedInstruments = new Set(ownedInstrumentsList)
                const allPositions = await venue.getPositions()
                const positions = filterPositionsByOwnership(allPositions, ownedInstruments)
                await backend.syncPositions(entry.strategy._id, app, positions)

                healthState.venues[app] = {
                    ...healthState.venues[app],
                    validated: true,
                    lastSyncAt: Date.now(),
                    lastSyncError: undefined,
                }

                await backend.reportHeartbeat(app, "healthy", {
                    source: "startup_sync",
                    strategyId: entry.strategy._id,
                    positionCount: positions.length,
                    balance: accountState.balance,
                })

                logger.info(`Startup sync completed for ${app}`, {
                    strategyId: entry.strategy._id,
                    balance: accountState.balance,
                    positions: positions.length,
                })
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                logger.error(`Startup sync failed for ${app}`, {
                    strategyId: entry.strategy._id,
                    error: message,
                })

                healthState.venues[app] = {
                    ...healthState.venues[app],
                    validated: healthState.venues[app]?.validated ?? false,
                    lastSyncError: message,
                }

                await backend.reportHeartbeat(app, "degraded", {
                    strategyId: entry.strategy._id,
                    error: message,
                    source: "startup_sync",
                })
            }
        }
    }
}

async function reconcileStrategies(scheduler: Scheduler): Promise<void> {
    const registered = new Set(scheduler.getRegisteredStrategies())

    for (const app of ALL_APPS) {
        const enabledStrategies = await backend.getStrategyConfigs(app)
        const enabledIds = new Set(enabledStrategies.map((s) => s._id))

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

        syncStrategies[app] = currentEntries.filter((e) => enabledIds.has(e.strategy._id))

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
        if (periodicSyncInFlight) return
        setPeriodicSyncInFlight(true)

        try {
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
    for (const [appKey, entries] of Object.entries(syncStrategies)) {
        const app = appKey as VenueApp
        const plugin = plugins[app]

        if (!healthState.venues[app]?.validated) continue

        for (const entry of entries) {
            try {
                const venue = plugin.createVenueAdapter(entry.policy, entry.secrets)
                const accountState = await venue.getAccountState()
                await accountSnapshotPersisters[app](accountState)

                const ownedInstrumentsList = await backend.getStrategyOwnedInstruments(entry.strategy._id)
                const ownedInstruments = new Set(ownedInstrumentsList)
                const allPositions = await venue.getPositions()
                const positions = filterPositionsByOwnership(allPositions, ownedInstruments)
                await backend.syncPositions(entry.strategy._id, app, positions)

                healthState.venues[app] = {
                    ...healthState.venues[app],
                    validated: true,
                    lastSyncAt: Date.now(),
                    lastSyncError: undefined,
                }

                await backend.reportHeartbeat(app, "healthy", {
                    source: "periodic_sync",
                    strategyId: entry.strategy._id,
                    positionCount: positions.length,
                    balance: accountState.balance,
                })
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                logger.error(`Periodic sync failed for ${app}`, {
                    strategyId: entry.strategy._id,
                    error: message,
                })

                healthState.venues[app] = {
                    ...healthState.venues[app],
                    validated: healthState.venues[app]?.validated ?? false,
                    lastSyncAt: Date.now(),
                    lastSyncError: message,
                }

                await backend.reportHeartbeat(app, "degraded", {
                    strategyId: entry.strategy._id,
                    error: message,
                    source: "periodic_sync",
                })

                await backend.createAlert({
                    app,
                    severity: "warning",
                    message: `Periodic sync failed for ${app} strategy ${entry.strategy.name}: ${message}`,
                })
            }
        }
    }
}

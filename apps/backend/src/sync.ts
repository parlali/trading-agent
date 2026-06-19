import {
    DEFAULT_STALE_RUN_TIMEOUT_MS,
    type Scheduler,
    type VenueApp,
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
import {
    reconcileProviderPortfolio,
    reconcileProviderPortfolioIfIdle,
    recordProviderSyncFailure,
} from "./provider-sync"
import { writeHeartbeatSnapshot } from "./health-write"
import {
    registerStrategyWithScheduler,
    resolveStrategyRuntimeState,
    syncStrategyEntryChanged,
    upsertSyncStrategyEntry,
} from "./scheduler"

type ProviderSyncSource = "startup_sync" | "periodic_sync"

async function syncProviderPortfolioForApp(
    app: VenueApp,
    source: ProviderSyncSource,
    options: {
        skipInvalidWarning?: boolean
        successLogMessage?: string
        failureLogMessage: string
        includeAppInFailureHeartbeat?: boolean
        alertFailure?: boolean
    }
): Promise<void> {
    if (!healthState.venues[app]?.validated) {
        if (options.skipInvalidWarning) {
            logger.warn(`Skipping startup sync for ${app}: environment not validated`)
        }
        return
    }

    const plugin = plugins[app]
    if (!plugin) return
    const allEntries = syncStrategies[app] ?? []
    if (allEntries.length === 0) {
        logger.warn(`Skipping provider sync for ${app}: no account-backed strategy entries`)
        return
    }

    const entriesByAccount = new Map<string, typeof allEntries[number]>()
    for (const entry of allEntries) {
        if (!entriesByAccount.has(entry.account.accountId)) {
            entriesByAccount.set(entry.account.accountId, entry)
        }
    }

    for (const entry of entriesByAccount.values()) {
        try {
            const venue = plugin.createVenueAdapter(entry.policy, entry.secrets)
            const syncResult = source === "periodic_sync"
                ? await reconcileProviderPortfolioIfIdle({
                    app,
                    accountId: entry.account.accountId,
                    venueName: plugin.venueName,
                    source,
                    venue,
                })
                : {
                    status: "completed" as const,
                    value: await reconcileProviderPortfolio({
                        app,
                        accountId: entry.account.accountId,
                        venueName: plugin.venueName,
                        source,
                        venue,
                    }),
                }

            if (syncResult.status === "skipped") {
                continue
            }

            const result = syncResult.value

            await writeHeartbeatSnapshot({
                app,
                status: result.driftDetected ? "degraded" : "healthy",
                metadata: {
                    source,
                    accountId: entry.account.accountId,
                    accountLabel: entry.account.label,
                    positionCount: result.positions.length,
                    pendingOrderCount: result.workingOrders.length,
                    balance: result.accountState.balance,
                    equity: result.accountState.equity,
                    driftDetected: result.driftDetected,
                    driftSummary: result.driftSummary,
                },
            })

            if (options.successLogMessage) {
                logger.info(options.successLogMessage, {
                    app,
                    accountId: entry.account.accountId,
                    positionCount: result.positions.length,
                    pendingOrderCount: result.workingOrders.length,
                    balance: result.accountState.balance,
                    equity: result.accountState.equity,
                    driftDetected: result.driftDetected,
                })
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.error(options.failureLogMessage, {
                app,
                accountId: entry.account.accountId,
                error: message,
            })

            await recordProviderSyncFailure(app, entry.account.accountId, message)

            await writeHeartbeatSnapshot({
                app,
                status: "degraded",
                metadata: {
                    ...(options.includeAppInFailureHeartbeat ? { app } : {}),
                    accountId: entry.account.accountId,
                    accountLabel: entry.account.label,
                    error: message,
                    source,
                },
            })

            if (options.alertFailure) {
                await backend.createAlert({
                    app,
                    severity: "warning",
                    message: `Periodic provider sync failed for ${app}:${entry.account.accountId}: ${message}`,
                })
            }
        }
    }
}

export async function performStartupSync(): Promise<void> {
    logger.info("Performing startup sync for validated venues")

    const requiredApps = getRequiredVenueApps(
        ALL_APPS,
        syncStrategies,
        await backend.getPortfolioFreshness()
    )

    for (const app of requiredApps) {
        await syncProviderPortfolioForApp(app, "startup_sync", {
            skipInvalidWarning: true,
            successLogMessage: "Startup provider sync completed",
            failureLogMessage: "Startup provider sync failed",
            includeAppInFailureHeartbeat: true,
        })
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
            const recoveredAgentChatMessages = await backend.recoverStaleAgentChatMessages()
            if (recoveredAgentChatMessages > 0) {
                logger.warn("Recovered stale agent chat turns during periodic sync", {
                    recoveredAgentChatMessages,
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
        await syncProviderPortfolioForApp(app, "periodic_sync", {
            failureLogMessage: "Periodic provider sync failed",
            alertFailure: true,
        })
    }
}

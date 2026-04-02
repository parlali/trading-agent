import type { Scheduler } from "@valiq-trading/core"
import {
    MANUAL_RUN_POLL_INTERVAL_MS,
    ALL_APPS,
    backend,
    logger,
    manualRunPollTimer,
    manualRunPollInFlight,
    setManualRunPollTimer,
    setManualRunPollInFlight,
} from "./state"
import { registerStrategyWithScheduler, pendingManualTriggers } from "./scheduler"

export function startManualRunPolling(scheduler: Scheduler): void {
    setManualRunPollTimer(setInterval(async () => {
        if (manualRunPollInFlight) {
            return
        }

        setManualRunPollInFlight(true)

        try {
            await pollManualRunRequests(scheduler)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.error("Failed to poll manual run requests", { error: message })
        } finally {
            setManualRunPollInFlight(false)
        }
    }, MANUAL_RUN_POLL_INTERVAL_MS))
}

export function stopManualRunPolling(): void {
    if (manualRunPollTimer) {
        clearInterval(manualRunPollTimer)
        setManualRunPollTimer(null)
    }
}

export async function pollManualRunRequests(scheduler: Scheduler): Promise<void> {
    for (const app of ALL_APPS) {
        const requests = await backend.getManualRunRequests(app)

        for (const request of requests) {
            let shouldClearRequest = false

            try {
                const registered = scheduler.getRegisteredStrategies()
                if (!registered.includes(request.strategyId)) {
                    const strategy = await backend.getStrategyById(request.strategyId)
                    if (!strategy) {
                        logger.warn("Manual run request for deleted strategy, clearing", {
                            strategyId: request.strategyId,
                        })
                        shouldClearRequest = true
                        continue
                    }
                    if (!strategy.enabled) {
                        logger.warn("Manual run request for disabled strategy, clearing", {
                            strategyId: request.strategyId,
                        })
                        shouldClearRequest = true
                        continue
                    }
                    logger.info("Hot-registering strategy for manual run", {
                        strategyId: strategy._id,
                        app,
                        name: strategy.name,
                    })
                    await registerStrategyWithScheduler(scheduler, app, strategy)
                }

                if (scheduler.isRunning(request.strategyId)) {
                    logger.info("Manual run remains queued until the current strategy run finishes", {
                        strategyId: request.strategyId,
                        app,
                    })
                    continue
                }

                pendingManualTriggers.add(request.strategyId)
                void scheduler.triggerManual(request.strategyId).catch((error) => {
                    pendingManualTriggers.delete(request.strategyId)
                    const message = error instanceof Error ? error.message : String(error)
                    logger.error("Manual run dispatch failed after scheduling", {
                        strategyId: request.strategyId,
                        app,
                        error: message,
                    })
                })

                logger.info("Manual run dispatched", {
                    strategyId: request.strategyId,
                    app,
                })
                shouldClearRequest = true
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                logger.error("Failed to process manual run request", {
                    strategyId: request.strategyId,
                    app,
                    error: message,
                })
            } finally {
                if (shouldClearRequest) {
                    await backend.clearManualRunRequest(request._id)
                }
            }
        }
    }
}

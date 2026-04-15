import type { Scheduler } from "@valiq-trading/core"
import {
    MANUAL_RUN_POLL_INTERVAL_MS,
    MANUAL_RUN_LEASE_MS,
    MANUAL_RUN_MAX_ATTEMPTS,
    MANUAL_RUN_CLAIM_LIMIT,
    MANUAL_RUN_WORKER_ID,
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
        const claimResult = await backend.claimManualRunRequests({
            app,
            workerId: MANUAL_RUN_WORKER_ID,
            leaseMs: MANUAL_RUN_LEASE_MS,
            maxClaims: MANUAL_RUN_CLAIM_LIMIT,
            maxAttempts: MANUAL_RUN_MAX_ATTEMPTS,
        })

        if (claimResult.contentionCount > 0) {
            logger.info("Manual run claim contention observed", {
                app,
                workerId: MANUAL_RUN_WORKER_ID,
                contentionCount: claimResult.contentionCount,
            })
        }

        if (claimResult.terminalizedCount > 0) {
            logger.warn("Manual run requests terminalized during claim because max attempts were exceeded", {
                app,
                terminalizedCount: claimResult.terminalizedCount,
                maxAttempts: claimResult.maxAttempts,
            })
        }

        for (const request of claimResult.claimed) {
            let ackOutcome: "completed" | "requeue" | "retryable_failure" | "terminal_failure" = "retryable_failure"
            let ackError: string | undefined
            try {
                const registered = scheduler.getRegisteredStrategies()
                if (!registered.includes(request.strategyId)) {
                    const strategy = await backend.getStrategyById(request.strategyId)
                    if (!strategy) {
                        logger.warn("Manual run request for deleted strategy, clearing", {
                            strategyId: request.strategyId,
                        })
                        ackOutcome = "terminal_failure"
                        ackError = "Strategy no longer exists"
                        continue
                    }
                    if (!strategy.enabled) {
                        logger.warn("Manual run request for disabled strategy, clearing", {
                            strategyId: request.strategyId,
                        })
                        ackOutcome = "terminal_failure"
                        ackError = "Strategy is disabled"
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
                    ackOutcome = "requeue"
                    ackError = "Strategy run already in progress"
                    continue
                }

                pendingManualTriggers.add(request.strategyId)
                await scheduler.triggerManual(request.strategyId)

                logger.info("Manual run dispatched", {
                    strategyId: request.strategyId,
                    app,
                })
                ackOutcome = "completed"
                ackError = undefined
            } catch (error) {
                pendingManualTriggers.delete(request.strategyId)
                const message = error instanceof Error ? error.message : String(error)
                logger.error("Failed to process manual run request", {
                    strategyId: request.strategyId,
                    app,
                    error: message,
                })
                ackOutcome = "retryable_failure"
                ackError = message
            } finally {
                try {
                    await backend.ackManualRunRequest({
                        requestId: request._id,
                        workerId: MANUAL_RUN_WORKER_ID,
                        outcome: ackOutcome,
                        error: ackError,
                        maxAttempts: MANUAL_RUN_MAX_ATTEMPTS,
                    })
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error)
                    logger.error("Failed to ack manual run request claim", {
                        strategyId: request.strategyId,
                        app,
                        requestId: request._id,
                        workerId: MANUAL_RUN_WORKER_ID,
                        outcome: ackOutcome,
                        error: message,
                    })
                }
            }
        }
    }
}

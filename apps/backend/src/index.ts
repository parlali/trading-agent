import { Scheduler, startHealthServer as startRuntimeHealthServer, wireShutdown as wireRuntimeShutdown } from "@valiq-trading/core"
import {
    APP_NAME,
    ALL_APPS,
    backend,
    healthPort,
    healthState,
    logger,
} from "./state"
import { resolveAllSecrets, validateAllEnvironments } from "./plugins/init"
import { registerStrategyWithScheduler } from "./scheduler"
import { startHeartbeat, stopHeartbeat } from "./heartbeat"
import { startManualRunPolling, stopManualRunPolling } from "./manual-runs"
import { performStartupSync, startPeriodicSync, stopPeriodicSync } from "./sync"
import { writeHeartbeatSnapshot } from "./health-write"

async function main(): Promise<void> {
    await resolveAllSecrets()
    const recoveredRuns = await backend.recoverRunningRuns()

    if (recoveredRuns > 0) {
        logger.warn("Recovered interrupted runs on backend startup", {
            recoveredRuns,
        })
    }

    const scheduler = new Scheduler({ logger })

    let totalStrategies = 0

    for (const app of ALL_APPS) {
        const strategies = await backend.getStrategyConfigs(app)
        const activeStrategies = strategies.filter((s) => s.enabled)
        totalStrategies += activeStrategies.length

        for (const strategy of activeStrategies) {
            await registerStrategyWithScheduler(scheduler, app, strategy)
        }

        logger.info(`Loaded ${activeStrategies.length} strategies for ${app}`)
    }

    await validateAllEnvironments(ALL_APPS)

    healthState.strategyCount = totalStrategies

    await performStartupSync()

    startHealthServer(scheduler)
    wireShutdown(scheduler)
    startHeartbeat()
    startManualRunPolling(scheduler)
    startPeriodicSync(scheduler)

    scheduler.start()
    healthState.ready = true

    await writeHeartbeatSnapshot({
        app: APP_NAME,
        status: "healthy",
        metadata: {
            source: "startup",
            strategyCount: totalStrategies,
            startedAt: healthState.startedAt,
            venues: Object.keys(healthState.venues),
        },
    })

    logger.info("Backend started", {
        strategies: scheduler.getRegisteredStrategies(),
        healthPort,
        totalStrategies,
    })
}

function startHealthServer(scheduler: Scheduler): void {
    startRuntimeHealthServer({
        port: healthPort,
        appName: APP_NAME,
        getHealth: () => ({
            ready: healthState.ready,
            startedAt: healthState.startedAt,
            strategyCount: healthState.strategyCount,
            venues: healthState.venues,
            registeredStrategies: scheduler.getRegisteredStrategies(),
            lastRunAt: healthState.lastRunAt,
            lastRunStatus: healthState.lastRunStatus,
            lastRunSummary: healthState.lastRunSummary,
            lastRunError: healthState.lastRunError,
        }),
    })
}

function wireShutdown(scheduler: Scheduler): void {
    wireRuntimeShutdown({
        appName: APP_NAME,
        scheduler,
        backend,
        onShutdown: () => {
            healthState.ready = false
            stopHeartbeat()
            stopManualRunPolling()
            stopPeriodicSync()
        },
    })
}

await main()

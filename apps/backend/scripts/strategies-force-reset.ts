import {
    createDeleteTotals,
    finalizeFullResetCleanup,
    printDeleteCounts,
    createClient,
    runScript,
    addDeleteCounts,
    assertFullResetAuditClean,
} from "./lib/strategy-cli"
import {
    createVenue,
    detectMarketClosedResetBlock,
    flattenVenueExposure,
    isDryRunStrategy,
    isMarketClosedExecutionFailure,
    type MarketClosedResetBlock,
    reconcileAndVerifyReset,
    resolveResetFlattenExposure,
    runWithResetExecutionContext,
} from "./lib/safe-strategy-reset"
import type {
    DeleteStrategyBatchResult,
    DeleteStrategyResult,
    StoredStrategy,
    TradingBackendClient,
} from "@valiq-trading/convex"

const FORCE_RESET_FLATTEN_ATTEMPTS = 5
const FORCE_RESET_FLATTEN_DELAY_MS = 1500
const STRATEGY_DELETE_BATCH_SIZE = 50
const STRATEGY_DELETE_MAX_BATCHES = 10000
const STRATEGY_DELETE_RETRY_ATTEMPTS = 3
const STRATEGY_DELETE_RETRY_DELAY_MS = 1500
const STRATEGY_DELETE_NO_PROGRESS_BATCH_LIMIT = 100

runScript(async () => {
    const client = createClient()
    const strategies = await client.getAllStrategies()
    const representativeStrategies = getRepresentativeStrategiesByApp(strategies)
    const deleted = createDeleteTotals()
    const deferredStrategyIds = new Set<string>()
    const deferredProviderApps = new Set<StoredStrategy["app"]>()
    const deferredProviderReasons = new Map<StoredStrategy["app"], string>()
    const deferProviderApp = (app: StoredStrategy["app"], reason: string) => {
        deferredProviderApps.add(app)
        deferredProviderReasons.set(app, reason)
    }

    if (strategies.length === 0) {
        console.log("No strategies found. Running full reset cleanup and audit...")
    } else {
        console.log("Destructive force reset requested")
        console.log("Expecting backend schedulers and workers to already be stopped before this runs")

        await preflightForceReset(client, representativeStrategies)

        const recoveredBeforeDisable = await client.recoverRunningRuns()
        console.log(`Recovered running runs before disable: ${recoveredBeforeDisable}`)

        for (const strategy of strategies) {
            await client.disableStrategy(strategy._id)
        }

        console.log(`Disabled ${strategies.length} strategies`)

        let cancelledOrders = 0
        let closedPositions = 0

        for (const strategy of representativeStrategies) {
            console.log(`  Flattening ${strategy.app} provider account using ${strategy.name}...`)

            if (isDryRunStrategy(strategy)) {
                console.log("    skipping venue flatten because this strategy is dry-run only")
                continue
            }

            if (deferredProviderApps.has(strategy.app)) {
                console.log(`    skipping venue flatten because ${deferredProviderReasons.get(strategy.app)}`)
                continue
            }

            for (let attempt = 1; attempt <= FORCE_RESET_FLATTEN_ATTEMPTS; attempt++) {
                const outcome = await runWithResetExecutionContext(
                    client,
                    strategy,
                    `force reset flatten attempt ${attempt}`,
                    async ({ venue, pipeline }) => {
                        const [positions, workingOrders] = await Promise.all([
                            venue.getPositions(),
                            venue.getWorkingOrders ? venue.getWorkingOrders() : Promise.resolve([]),
                        ])

                        if (positions.length === 0 && workingOrders.length === 0) {
                            return { stop: true, deferred: false }
                        }

                        const flattenExposure = await resolveResetFlattenExposure(client, strategy, {
                            app: strategy.app,
                            positions,
                            workingOrders,
                        })
                        printAlpacaEmergencyCloseGroups(flattenExposure.positions)

                        const preExistingMarketCloseBlock = await detectMarketClosedResetBlock(strategy.app, venue, flattenExposure)
                        if (preExistingMarketCloseBlock) {
                            printMarketClosedResetBlock(strategy, preExistingMarketCloseBlock)
                            return { stop: true, deferred: true }
                        }

                        console.log(
                            `    attempt ${attempt}/${FORCE_RESET_FLATTEN_ATTEMPTS}: ${positions.length} live position(s), ${workingOrders.length} live working order(s)`
                        )

                        const result = await flattenVenueExposure(pipeline, flattenExposure)

                        cancelledOrders += result.cancelledOrders
                        closedPositions += result.closedPositions

                        for (const failure of result.orderFailures) {
                            console.log(`      ${failure}`)
                        }

                        for (const failure of result.positionFailures) {
                            console.log(`      ${failure}`)
                        }

                        const marketClosedFailure = [
                            ...result.orderFailures,
                            ...result.positionFailures,
                        ].find((failure) => isMarketClosedExecutionFailure(strategy.app, failure))
                        if (marketClosedFailure) {
                            printMarketClosedExecutionFailure(strategy, marketClosedFailure)
                            return { stop: true, deferred: true }
                        }

                        const postPositions = await venue.getPositions()
                        const postWorkingOrders = venue.getWorkingOrders
                            ? await venue.getWorkingOrders()
                            : []
                        const postFlattenExposure = await resolveResetFlattenExposure(client, strategy, {
                            app: strategy.app,
                            positions: postPositions,
                            workingOrders: postWorkingOrders,
                        })
                        const marketCloseBlock = await detectMarketClosedResetBlock(strategy.app, venue, postFlattenExposure)
                        if (marketCloseBlock) {
                            printMarketClosedResetBlock(strategy, marketCloseBlock)
                            return { stop: true, deferred: true }
                        }

                        return { stop: false, deferred: false }
                    }
                )

                if (outcome.deferred) {
                    deferredStrategyIds.add(String(strategy._id))
                    deferProviderApp(
                        strategy.app,
                        "provider market closed or existing close orders are still live; live provider rows intentionally preserved"
                    )
                    break
                }

                if (outcome.stop) {
                    break
                }

                if (attempt < FORCE_RESET_FLATTEN_ATTEMPTS) {
                    await sleep(FORCE_RESET_FLATTEN_DELAY_MS)
                }
            }

            if (!deferredStrategyIds.has(String(strategy._id))) {
                await reconcileAndVerifyReset(client, strategy)
            }
        }

        const recoveredBeforeDelete = await client.recoverRunningRuns()
        console.log(`Recovered running runs before delete: ${recoveredBeforeDelete}`)

        for (const strategy of strategies) {
            if (deferredProviderApps.has(strategy.app)) {
                console.log(`Keeping disabled strategy with deferred provider exposure: ${strategy.name} (${strategy.app})`)
                continue
            }

            console.log(`Deleting reset strategy: ${strategy.name} (${strategy.app})`)
            const result = await deleteStrategyWithContext(client, strategy)
            if (result.strategyDeleted) {
                deleted.strategies++
            }
            addDeleteCounts(deleted, result.deleted)
        }

        console.log("Provider cleanup:")
        console.log(`  cancelled orders: ${cancelledOrders}`)
        console.log(`  closed positions: ${closedPositions}`)
    }

    const cleanup = await finalizeFullResetCleanup(client, {
        allowedProviderExposureApps: Array.from(deferredProviderApps),
        log: (message) => console.log(`  ${message}`),
    })
    addDeleteCounts(deleted, cleanup.deleted)

    console.log("Deleted:")
    printDeleteCounts(deleted)
    if (deferredProviderApps.size > 0) {
        console.log("Full reset audit deferred for provider exposure:")
        for (const app of deferredProviderApps) {
            console.log(`  ${app}: ${deferredProviderReasons.get(app) ?? "live provider rows intentionally preserved"}`)
        }
        console.log("Backend reset completed with deferred provider cleanup")
    } else {
        assertFullResetAuditClean(cleanup.audit)
        console.log("Full reset audit passed")
    }
})

async function preflightForceReset(
    client: TradingBackendClient,
    strategies: StoredStrategy[]
): Promise<void> {
    const failures: string[] = []

    console.log("Preflighting venue access before destructive reset...")

    for (const strategy of strategies) {
        if (isDryRunStrategy(strategy)) {
            console.log(`  ${strategy.app}: ${strategy.name} -> dry-run only, venue preflight skipped`)
            continue
        }

        try {
            const { venue } = await createVenue(strategy, client)
            await venue.getAccountState()
            console.log(`  ${strategy.app}: ${strategy.name} -> venue access OK`)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            failures.push(`${strategy.app}: ${strategy.name} -> ${message}`)
            console.log(`  ${strategy.app}: ${strategy.name} -> FAILED (${message})`)
        }
    }

    if (failures.length > 0) {
        throw new Error(`Force reset preflight failed:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`)
    }
}

function getRepresentativeStrategiesByApp(
    strategies: StoredStrategy[]
): StoredStrategy[] {
    const strategiesByApp = new Map<StoredStrategy["app"], StoredStrategy>()

    for (const strategy of strategies) {
        const existing = strategiesByApp.get(strategy.app)
        if (!existing) {
            strategiesByApp.set(strategy.app, strategy)
            continue
        }

        if (isDryRunStrategy(existing) && !isDryRunStrategy(strategy)) {
            strategiesByApp.set(strategy.app, strategy)
        }
    }

    return Array.from(strategiesByApp.values())
}

function printAlpacaEmergencyCloseGroups(
    positions: Array<{ instrument: string; metadata?: Record<string, unknown> }>
): void {
    const emergencyGroups = positions.filter((position) =>
        position.metadata?.alpacaEmergencyCloseGroup === true
    )

    if (emergencyGroups.length === 0) {
        return
    }

    console.log(
        `    warning: emergency reconstructed ${emergencyGroups.length} Alpaca raw-leg close group(s) from provider positions: ${emergencyGroups.map((position) => position.instrument).join(", ")}`
    )
}

function printMarketClosedResetBlock(
    strategy: StoredStrategy,
    block: MarketClosedResetBlock
): void {
    const closeOrderDetail = block.workingOrders.length > 0
        ? `${block.workingOrders.length} matching working close order(s)`
        : "no working close order(s)"
    console.log(
        `    warning: ${block.provider} market is closed and ${block.positions.length} provider position(s) remain with ${closeOrderDetail}.`
    )
    if (block.nextOpen) {
        console.log(`    next provider open: ${block.nextOpen}`)
    }
    console.log("    backend reset will continue for other provider apps. Deferred provider rows remain preserved until the broker fills, cancels, or the market opens.")
    console.log(`    strategy: ${strategy.name}`)
}

function printMarketClosedExecutionFailure(
    strategy: StoredStrategy,
    failure: string
): void {
    console.log(`    warning: ${strategy.app} market is closed and provider rejected the flatten attempt.`)
    console.log(`    provider response: ${failure}`)
    console.log("    backend reset will continue for other provider apps. Deferred provider rows remain preserved until the broker fills, cancels, or the market opens.")
    console.log(`    strategy: ${strategy.name}`)
}

async function deleteStrategyWithContext(
    client: TradingBackendClient,
    strategy: StoredStrategy
): Promise<{
    deleted: DeleteStrategyResult
    strategyDeleted: boolean
}> {
    const deleted = createDeleteTotals()
    let strategyDeleted = false
    let consecutiveNoProgressBatches = 0

    try {
        for (let batch = 1; batch <= STRATEGY_DELETE_MAX_BATCHES; batch++) {
            const result = await deleteStrategyBatchWithRetry(client, strategy)
            const deletedThisBatch = sumDeleteCounts(result)
            if (deletedThisBatch === 0 && !result.strategyDeleted) {
                consecutiveNoProgressBatches++
            } else {
                consecutiveNoProgressBatches = 0
            }

            if (consecutiveNoProgressBatches >= STRATEGY_DELETE_NO_PROGRESS_BATCH_LIMIT) {
                throw new Error(
                    `Delete made no progress for ${STRATEGY_DELETE_NO_PROGRESS_BATCH_LIMIT} consecutive batches. Verify backend writers are stopped and provider sync rows are not being re-created during reset.`
                )
            }

            addDeleteCounts(deleted, result)
            strategyDeleted = strategyDeleted || result.strategyDeleted

            if (!result.hasMore) {
                return {
                    deleted,
                    strategyDeleted,
                }
            }

            if (batch % 25 === 0) {
                console.log(
                    `  deleted ${batch} batch(es) for ${strategy.name}: last_batch=${deletedThisBatch}, runs=${deleted.runs}, logs=${deleted.agentLogs}, events=${deleted.tradeEvents}, orders=${deleted.orders}, transitions=${deleted.orderTransitions}, provider_positions=${deleted.providerPositions}, provider_working_orders=${deleted.providerWorkingOrders}, provider_sync_states=${deleted.providerSyncStates}, account_snapshots=${deleted.accountSnapshots}, app_heartbeats=${deleted.appHeartbeats}`
                )
            }
        }

        throw new Error(`Exceeded ${STRATEGY_DELETE_MAX_BATCHES} delete batches`)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`Failed deleting reset strategy ${strategy.name} (${strategy.app}, ${strategy._id}): ${message}`)
    }
}

async function deleteStrategyBatchWithRetry(
    client: TradingBackendClient,
    strategy: StoredStrategy
): Promise<DeleteStrategyBatchResult> {
    let lastError: unknown

    for (let attempt = 1; attempt <= STRATEGY_DELETE_RETRY_ATTEMPTS; attempt++) {
        try {
            return await client.deleteStrategyBatch(strategy._id, STRATEGY_DELETE_BATCH_SIZE)
        } catch (error) {
            lastError = error
            const message = error instanceof Error ? error.message : String(error)
            const isRetryable =
                message.includes("Server Error") ||
                message.includes("Request ID") ||
                message.includes("network") ||
                message.includes("timed out")

            if (!isRetryable || attempt === STRATEGY_DELETE_RETRY_ATTEMPTS) {
                throw error
            }

            console.log(
                `  warning: delete batch failed for ${strategy.name} (${strategy.app}) on attempt ${attempt}/${STRATEGY_DELETE_RETRY_ATTEMPTS}: ${message}`
            )
            await sleep(STRATEGY_DELETE_RETRY_DELAY_MS)
        }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

function sumDeleteCounts(result: DeleteStrategyBatchResult): number {
    return (
        result.runs +
        result.agentLogs +
        result.tradeEvents +
        result.orders +
        result.orderTransitions +
        result.positions +
        result.instrumentClaims +
        result.positionSyncs +
        result.strategyRiskStates +
        result.executionSafetyFaults +
        result.providerPositions +
        result.providerWorkingOrders +
        result.providerSyncStates +
        result.accountSnapshots +
        result.appHeartbeats +
        result.manualRunRequests +
        result.alerts
    )
}

async function sleep(delayMs: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
}

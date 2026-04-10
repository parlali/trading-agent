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
    flattenVenueExposure,
    isDryRunStrategy,
    reconcileAndVerifyReset,
} from "./lib/safe-strategy-reset"
import type { StoredStrategy, TradingBackendClient } from "@valiq-trading/convex"
import { MT5VenueAdapter } from "@valiq-trading/mt5"

const FORCE_RESET_FLATTEN_ATTEMPTS = 5
const FORCE_RESET_FLATTEN_DELAY_MS = 1500

runScript(async () => {
    const client = createClient()
    const strategies = await client.getAllStrategies()
    const representativeStrategies = getRepresentativeStrategiesByApp(strategies)
    const deleted = createDeleteTotals()

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

            for (let attempt = 1; attempt <= FORCE_RESET_FLATTEN_ATTEMPTS; attempt++) {
                const { venue } = await createVenue(strategy, client)
                const [positions, workingOrders] = await Promise.all([
                    venue.getPositions(),
                    venue.getWorkingOrders ? venue.getWorkingOrders() : Promise.resolve([]),
                ])

                if (positions.length === 0 && workingOrders.length === 0) {
                    break
                }

                console.log(
                    `    attempt ${attempt}/${FORCE_RESET_FLATTEN_ATTEMPTS}: ${positions.length} live position(s), ${workingOrders.length} live working order(s)`
                )

                const result =
                    venue instanceof MT5VenueAdapter && workingOrders.length > 0
                        ? await flattenMT5Exposure(venue, positions, workingOrders)
                        : await flattenVenueExposure(venue, {
                            positions,
                            workingOrders,
                        })

                cancelledOrders += result.cancelledOrders
                closedPositions += result.closedPositions

                for (const failure of result.orderFailures) {
                    console.log(`      ${failure}`)
                }

                for (const failure of result.positionFailures) {
                    console.log(`      ${failure}`)
                }

                if (attempt < FORCE_RESET_FLATTEN_ATTEMPTS) {
                    await sleep(FORCE_RESET_FLATTEN_DELAY_MS)
                }
            }

            await reconcileAndVerifyReset(client, strategy, undefined, {
                requireHealthyState: false,
            })
        }

        const recoveredBeforeDelete = await client.recoverRunningRuns()
        console.log(`Recovered running runs before delete: ${recoveredBeforeDelete}`)

        for (const strategy of strategies) {
            const result = await client.deleteStrategy(strategy._id)
            deleted.strategies++
            addDeleteCounts(deleted, result)
        }

        console.log("Provider cleanup:")
        console.log(`  cancelled orders: ${cancelledOrders}`)
        console.log(`  closed positions: ${closedPositions}`)
    }

    const cleanup = await finalizeFullResetCleanup(client, {
        log: (message) => console.log(`  ${message}`),
    })
    addDeleteCounts(deleted, cleanup.deleted)

    console.log("Deleted:")
    printDeleteCounts(deleted)
    assertFullResetAuditClean(cleanup.audit)
    console.log("Full reset audit passed")
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

async function sleep(delayMs: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
}

async function flattenMT5Exposure(
    venue: MT5VenueAdapter,
    positions: Awaited<ReturnType<MT5VenueAdapter["getPositions"]>>,
    workingOrders: Awaited<ReturnType<MT5VenueAdapter["getWorkingOrders"]>>
): Promise<{
    cancelledOrders: number
    closedPositions: number
    orderFailures: string[]
    positionFailures: string[]
}> {
    const cancelled = await venue.cancelAllOrders()
    const orderFailures: string[] = []

    for (const result of cancelled.results) {
        if (result.status !== "cancelled" && result.status !== "filled") {
            orderFailures.push(
                `MT5 order ${result.orderId || "<unknown>"}: ${result.error ?? result.status}`
            )
        }
    }

    const closed = await flattenVenueExposure(venue, {
        positions,
        workingOrders: [],
    })

    return {
        cancelledOrders: cancelled.cancelled,
        closedPositions: closed.closedPositions,
        orderFailures: [...orderFailures, ...closed.orderFailures],
        positionFailures: closed.positionFailures,
    }
}

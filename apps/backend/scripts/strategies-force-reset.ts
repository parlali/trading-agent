import {
    printDeleteCounts,
    createClient,
    runScript,
} from "./lib/strategy-cli"
import {
    createVenue,
    flattenVenueExposure,
    isDryRunStrategy,
    reconcileAndVerifyReset,
} from "./lib/safe-strategy-reset"
import type { StoredStrategy } from "@valiq-trading/convex"

const FORCE_RESET_FLATTEN_ATTEMPTS = 5
const FORCE_RESET_FLATTEN_DELAY_MS = 1500

runScript(async () => {
    const client = createClient()
    const strategies = await client.getAllStrategies()

    if (strategies.length === 0) {
        console.log("No strategies to reset")
        return
    }

    console.log("Destructive force reset requested")
    console.log("Expecting backend schedulers and workers to already be stopped before this runs")

    const recoveredBeforeDisable = await client.recoverRunningRuns()
    console.log(`Recovered running runs before disable: ${recoveredBeforeDisable}`)

    for (const strategy of strategies) {
        await client.disableStrategy(strategy._id)
    }

    console.log(`Disabled ${strategies.length} strategies`)

    let cancelledOrders = 0
    let closedPositions = 0

    for (const strategy of getRepresentativeStrategiesByApp(strategies)) {
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

            const result = await flattenVenueExposure(venue, {
                positions,
                workingOrders,
            })

            cancelledOrders += result.cancelledOrders
            closedPositions += result.closedPositions

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

    const deleted = await client.deleteAllStrategies()

    console.log("Provider cleanup:")
    console.log(`  cancelled orders: ${cancelledOrders}`)
    console.log(`  closed positions: ${closedPositions}`)
    console.log("Deleted:")
    printDeleteCounts(deleted)
})

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

import {
    addDeleteCounts,
    createClient,
    createDeleteTotals,
    flushOrphanedStrategyHistory,
    printDeleteCounts,
    runScript,
} from "./lib/strategy-cli"
import { resetStrategySafely } from "./lib/safe-strategy-reset"

runScript(async () => {
    const client = createClient()
    const strategies = await client.getAllStrategies()

    if (strategies.length === 0) {
        console.log("No strategies to delete")
        return
    }

    console.log(`Safely resetting ${strategies.length} strategies and associated data...`)

    const totals = createDeleteTotals()

    for (const strategy of strategies) {
        console.log(`  Resetting ${strategy.name}...`)
        const result = await resetStrategySafely(client, strategy._id)
        totals.strategies++
        console.log(`    cancelled orders: ${result.cancelledOrders}`)
        console.log(`    closed positions: ${result.closedPositions}`)
        addDeleteCounts(totals, result.deleted)
    }

    const orphaned = await flushOrphanedStrategyHistory(client, {
        log: (message) => console.log(`  ${message}`),
    })
    addDeleteCounts(totals, orphaned)

    console.log("Deleted:")
    printDeleteCounts(totals)
})

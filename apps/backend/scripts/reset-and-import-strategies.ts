import {
    addDeleteCounts,
    createClient,
    createDeleteTotals,
    flushOrphanedStrategyHistory,
    getStrategyModel,
    loadStrategiesFromDocument,
    printDeleteCounts,
    runScript,
} from "./lib/strategy-cli"
import { resetStrategySafely } from "./lib/safe-strategy-reset"

runScript(async () => {
    const strategies = await loadStrategiesFromDocument()
    const client = createClient()

    const existing = await client.getAllStrategies()

    const totals = createDeleteTotals()

    if (existing.length > 0) {
        console.log(`Safely resetting ${existing.length} existing strategies...`)

        for (const strategy of existing) {
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
        console.log("")
    }

    console.log(`Importing ${strategies.length} strategies...`)

    for (const strategy of strategies) {
        await client.addStrategy(strategy)
        console.log(`  + ${strategy.name} (${strategy.app}, model=${getStrategyModel(strategy)})`)
    }

    console.log(`Imported ${strategies.length} strategies`)
})

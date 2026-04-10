import {
    createClient,
    createDeleteTotals,
    finalizeFullResetCleanup,
    getStrategyModel,
    loadStrategiesFromDocument,
    printDeleteCounts,
    runScript,
    addDeleteCounts,
    assertFullResetAuditClean,
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

    } else {
        console.log("No existing strategies found. Running full reset cleanup and audit before import...")
    }

    const cleanup = await finalizeFullResetCleanup(client, {
        log: (message) => console.log(`  ${message}`),
    })
    addDeleteCounts(totals, cleanup.deleted)

    console.log("Deleted:")
    printDeleteCounts(totals)
    assertFullResetAuditClean(cleanup.audit)
    console.log("Full reset audit passed")
    console.log("")

    console.log(`Importing ${strategies.length} strategies...`)

    for (const strategy of strategies) {
        await client.addStrategy(strategy)
        console.log(`  + ${strategy.name} (${strategy.app}, model=${getStrategyModel(strategy)})`)
    }

    console.log(`Imported ${strategies.length} strategies`)
})

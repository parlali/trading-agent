import {
    createClient,
    createDeleteTotals,
    finalizeFullResetCleanup,
    printDeleteCounts,
    runScript,
    addDeleteCounts,
    assertFullResetAuditClean,
} from "./lib/strategy-cli"
import { resetStrategySafely } from "./lib/safe-strategy-reset"

runScript(async () => {
    const client = createClient()
    const strategies = await client.getAllStrategies()
    const totals = createDeleteTotals()

    if (strategies.length === 0) {
        console.log("No strategies to reset. Running full reset cleanup and audit...")
    } else {
        console.log(`Safely resetting ${strategies.length} strategies and associated data...`)

        for (const strategy of strategies) {
            console.log(`  Resetting ${strategy.name}...`)
            const result = await resetStrategySafely(client, strategy._id)
            totals.strategies++
            console.log(`    cancelled orders: ${result.cancelledOrders}`)
            console.log(`    closed positions: ${result.closedPositions}`)
            addDeleteCounts(totals, result.deleted)
        }
    }

    const cleanup = await finalizeFullResetCleanup(client, {
        log: (message) => console.log(`  ${message}`),
    })
    addDeleteCounts(totals, cleanup.deleted)

    console.log("Deleted:")
    printDeleteCounts(totals)
    assertFullResetAuditClean(cleanup.audit)
    console.log("Full reset audit passed")
})

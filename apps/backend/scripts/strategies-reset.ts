import {
    createClient,
    finalizeFullResetCleanup,
    printDeleteCounts,
    runScript,
    addDeleteCounts,
    assertFullResetAuditClean,
} from "./lib/strategy-cli"
import { resetExistingStrategies } from "./lib/strategy-reset"

runScript(async () => {
    const client = createClient()
    const strategies = await client.getAllStrategies()
    const totals = await resetExistingStrategies(client, strategies, {
        empty: "No strategies to reset. Running full reset cleanup and audit...",
        reset: (count) => `Safely resetting ${count} strategies and associated data...`,
    })

    const cleanup = await finalizeFullResetCleanup(client, {
        log: (message) => console.log(`  ${message}`),
    })
    addDeleteCounts(totals, cleanup.deleted)

    console.log("Deleted:")
    printDeleteCounts(totals)
    assertFullResetAuditClean(cleanup.audit)
    console.log("Full reset audit passed")
})

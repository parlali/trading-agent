import {
    createClient,
    finalizeFullResetCleanup,
    getStrategyLlmSummary,
    loadStrategiesFromDocument,
    printDeleteCounts,
    runScript,
    addDeleteCounts,
    assertFullResetAuditClean,
} from "./lib/strategy-cli"
import { resetExistingStrategies } from "./lib/strategy-reset"

runScript(async () => {
    const strategies = await loadStrategiesFromDocument()
    const client = createClient()

    const existing = await client.getAllStrategies()

    const totals = await resetExistingStrategies(client, existing, {
        empty: "No existing strategies found. Running full reset cleanup and audit before import...",
        reset: (count) => `Safely resetting ${count} existing strategies...`,
    })

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
        console.log(`  + ${strategy.name} (${strategy.app}, llm=${getStrategyLlmSummary(strategy)})`)
    }

    console.log(`Imported ${strategies.length} strategies`)
})

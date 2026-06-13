import {
    createClient,
    finalizeFullResetCleanup,
    getStrategyLlmSummary,
    loadStrategyDocumentFromDisk,
    printDeleteCounts,
    runScript,
    addDeleteCounts,
    assertFullResetAuditClean,
} from "./lib/strategy-cli"
import { resetExistingStrategies } from "./lib/strategy-reset"

runScript(async () => {
    const { accounts, strategies } = await loadStrategyDocumentFromDisk()
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

    console.log(`Importing ${accounts.length} accounts and ${strategies.length} strategies...`)

    for (const account of accounts) {
        await client.upsertAccount(account)
        console.log(`  + account ${account.app}:${account.accountId} (${account.label}, prefix=${account.credentialEnvPrefix})`)
    }

    for (const strategy of strategies) {
        await client.addStrategy(strategy)
        console.log(`  + ${strategy.name} (${strategy.app}:${strategy.accountId}, llm=${getStrategyLlmSummary(strategy)})`)
    }

    console.log(`Imported ${accounts.length} accounts and ${strategies.length} strategies`)
})

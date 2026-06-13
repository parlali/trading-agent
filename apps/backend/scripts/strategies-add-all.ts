import {
    createClient,
    getStrategyLlmSummary,
    loadStrategyDocumentFromDisk,
    resolveArg,
    runScript,
} from "./lib/strategy-cli"

runScript(async () => {
    const { accounts, strategies } = await loadStrategyDocumentFromDisk()
    const excludedApps = new Set(
        (resolveArg("exclude-app") ?? "")
            .split(",")
            .map((app) => app.trim())
            .filter(Boolean)
    )
    const client = createClient()
    let importedAccounts = 0
    let imported = 0
    let skipped = 0

    for (const account of accounts) {
        if (excludedApps.has(account.app)) {
            continue
        }

        await client.upsertAccount(account)
        importedAccounts++
        console.log(`Upserted account "${account.label}" (${account.app}:${account.accountId}, prefix=${account.credentialEnvPrefix}, status=${account.status})`)
    }

    for (const config of strategies) {
        if (excludedApps.has(config.app)) {
            skipped++
            console.log(`Skipped "${config.name}" (${config.app}) due to --exclude-app`)
            continue
        }

        const id = await client.addStrategy(config)
        imported++
        console.log(`Added "${config.name}" (${config.app}:${config.accountId}, enabled=${config.enabled}, llm=${getStrategyLlmSummary(config)}) -> ${id}`)
    }

    console.log(`\nImported ${importedAccounts} accounts and ${imported} strategies${skipped > 0 ? `, skipped ${skipped}` : ""}`)
})

import {
    createClient,
    getStrategyLlmSummary,
    runScript,
} from "./lib/strategy-cli"

runScript(async () => {
    const client = createClient()
    const [accounts, strategies] = await Promise.all([
        client.getAccounts(),
        client.getAllStrategies(),
    ])
    const accountsByKey = new Map(accounts.map((account) => [`${account.app}:${account.accountId}`, account]))

    if (strategies.length === 0) {
        console.log("No strategies in backend")
        return
    }

    console.log(`${accounts.length} accounts:\n`)
    for (const account of accounts) {
        console.log(`  ${account.label}`)
        console.log(`    account: ${account.app}:${account.accountId}  |  ${account.status}`)
        console.log(`    credential prefix: ${account.credentialEnvPrefix}`)
        if (account.notes) {
            console.log(`    notes: ${account.notes}`)
        }
        console.log("")
    }

    console.log(`${strategies.length} strategies:\n`)

    for (const s of strategies) {
        const dryRun = (s.policy as Record<string, unknown>).dryRun
        const mode = dryRun ? "dryrun" : "live"
        const status = s.enabled ? "enabled" : "disabled"
        console.log(`  ${s.name}`)
        console.log(`    id: ${s._id}`)
        const account = accountsByKey.get(`${s.app}:${s.accountId}`)
        console.log(`    app: ${s.app}  |  account: ${s.accountId}${account ? ` (${account.label})` : " (missing)"}  |  ${status}  |  ${mode}`)
        try {
            console.log(`    llm: ${getStrategyLlmSummary(s as { policy: Record<string, unknown> })}`)
        } catch {
            console.log(`    llm: (missing)`)
        }
        console.log(`    schedule: ${s.schedule}`)
        console.log("")
    }
})

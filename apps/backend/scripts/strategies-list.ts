import {
    createClient,
    getStrategyLlmSummary,
    runScript,
} from "./lib/strategy-cli"

runScript(async () => {
    const client = createClient()
    const strategies = await client.getAllStrategies()

    if (strategies.length === 0) {
        console.log("No strategies in backend")
        return
    }

    console.log(`${strategies.length} strategies:\n`)

    for (const s of strategies) {
        const dryRun = (s.policy as Record<string, unknown>).dryRun
        const mode = dryRun ? "dryrun" : "live"
        const status = s.enabled ? "enabled" : "disabled"
        console.log(`  ${s.name}`)
        console.log(`    id: ${s._id}`)
        console.log(`    app: ${s.app}  |  ${status}  |  ${mode}`)
        try {
            console.log(`    llm: ${getStrategyLlmSummary(s as { policy: Record<string, unknown> })}`)
        } catch {
            console.log(`    llm: (missing)`)
        }
        console.log(`    schedule: ${s.schedule}`)
        console.log("")
    }
})

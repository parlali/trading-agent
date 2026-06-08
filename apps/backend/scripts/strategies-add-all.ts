import {
    createClient,
    getStrategyLlmSummary,
    loadStrategiesFromDocument,
    resolveArg,
    runScript,
} from "./lib/strategy-cli"

runScript(async () => {
    const strategies = await loadStrategiesFromDocument()
    const excludedApps = new Set(
        (resolveArg("exclude-app") ?? "")
            .split(",")
            .map((app) => app.trim())
            .filter(Boolean)
    )
    const client = createClient()
    let imported = 0
    let skipped = 0

    for (const config of strategies) {
        if (excludedApps.has(config.app)) {
            skipped++
            console.log(`Skipped "${config.name}" (${config.app}) due to --exclude-app`)
            continue
        }

        const id = await client.addStrategy(config)
        imported++
        console.log(`Added "${config.name}" (${config.app}, enabled=${config.enabled}, llm=${getStrategyLlmSummary(config)}) -> ${id}`)
    }

    console.log(`\nImported ${imported} strategies${skipped > 0 ? `, skipped ${skipped}` : ""}`)
})

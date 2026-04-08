import {
    createClient,
    loadStrategiesFromDocument,
    runScript,
} from "./lib/strategy-cli"

runScript(async () => {
    const strategies = await loadStrategiesFromDocument()
    const client = createClient()

    for (const config of strategies) {
        const id = await client.addStrategy(config)
        console.log(`Added "${config.name}" (${config.app}, enabled=${config.enabled}) -> ${id}`)
    }

    console.log(`\nImported ${strategies.length} strategies`)
})

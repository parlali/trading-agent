import {
    createClient,
    getStrategyModel,
    loadStrategiesFromDocument,
    runScript,
} from "./lib/strategy-cli"

runScript(async () => {
    const strategies = await loadStrategiesFromDocument()
    const client = createClient()

    for (const config of strategies) {
        const id = await client.addStrategy(config)
        console.log(`Added "${config.name}" (${config.app}, enabled=${config.enabled}, model=${getStrategyModel(config)}) -> ${id}`)
    }

    console.log(`\nImported ${strategies.length} strategies`)
})

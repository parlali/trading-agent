import {
    createClient,
    loadStrategiesFromDocument,
    findStrategyByName,
    requireArg,
    runScript,
} from "./lib/strategy-cli"

runScript(async () => {
    const name = requireArg("name")
    const strategies = await loadStrategiesFromDocument()
    const config = findStrategyByName(strategies, name)

    const client = createClient()
    const id = await client.addStrategy(config)

    console.log(`Added "${config.name}" (${config.app}, enabled=${config.enabled})`)
    console.log(`ID: ${id}`)
})

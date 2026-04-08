import {
    createClient,
    loadStrategiesFromDocument,
    printDeleteCounts,
    runScript,
} from "./lib/strategy-cli"

runScript(async () => {
    const strategies = await loadStrategiesFromDocument()
    const client = createClient()

    const existing = await client.getAllStrategies()

    const totals = {
        strategies: 0,
        runs: 0,
        agentLogs: 0,
        tradeEvents: 0,
        orders: 0,
        orderTransitions: 0,
        positions: 0,
        instrumentClaims: 0,
        positionSyncs: 0,
        manualRunRequests: 0,
        alerts: 0,
    }

    if (existing.length > 0) {
        console.log(`Deleting ${existing.length} existing strategies...`)

        for (const strategy of existing) {
            console.log(`  Deleting ${strategy.name}...`)
            const result = await client.deleteStrategy(strategy._id)
            totals.strategies++
            for (const key of Object.keys(result) as Array<keyof typeof result>) {
                if (key in totals) {
                    (totals as Record<string, number>)[key] += result[key] as number
                }
            }
        }

        console.log("Deleted:")
        printDeleteCounts(totals)
        console.log("")
    }

    console.log(`Importing ${strategies.length} strategies...`)

    for (const strategy of strategies) {
        await client.addStrategy(strategy)
        console.log(`  + ${strategy.name}`)
    }

    console.log(`Imported ${strategies.length} strategies`)
})

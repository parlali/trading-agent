import {
    createClient,
    printDeleteCounts,
    runScript,
} from "./lib/strategy-cli"

runScript(async () => {
    const client = createClient()
    const strategies = await client.getAllStrategies()

    if (strategies.length === 0) {
        console.log("No strategies to delete")
        return
    }

    console.log(`Deleting ${strategies.length} strategies and associated data...`)

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

    for (const strategy of strategies) {
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
})

import {
    createClient,
    printDeleteCounts,
    runScript,
} from "./lib/strategy-cli"
import { resetStrategySafely } from "./lib/safe-strategy-reset"

runScript(async () => {
    const client = createClient()
    const strategies = await client.getAllStrategies()

    if (strategies.length === 0) {
        console.log("No strategies to delete")
        return
    }

    console.log(`Safely resetting ${strategies.length} strategies and associated data...`)

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
        providerPositions: 0,
        providerWorkingOrders: 0,
        providerSyncStates: 0,
        accountSnapshots: 0,
        appHeartbeats: 0,
        manualRunRequests: 0,
        alerts: 0,
    }

    for (const strategy of strategies) {
        console.log(`  Resetting ${strategy.name}...`)
        const result = await resetStrategySafely(client, strategy._id)
        totals.strategies++
        console.log(`    cancelled orders: ${result.cancelledOrders}`)
        console.log(`    closed positions: ${result.closedPositions}`)
        for (const key of Object.keys(result.deleted) as Array<keyof typeof result.deleted>) {
            if (key in totals) {
                const numericTotals = totals as Record<string, number>
                numericTotals[key] += result.deleted[key] as number
            }
        }
    }

    console.log("Deleted:")
    printDeleteCounts(totals)
})

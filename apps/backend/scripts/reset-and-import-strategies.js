import { createClient, getStrategyModel, loadStrategiesFromDocument, printDeleteCounts, runScript, } from "./lib/strategy-cli";
import { resetStrategySafely } from "./lib/safe-strategy-reset";
runScript(async () => {
    const strategies = await loadStrategiesFromDocument();
    const client = createClient();
    const existing = await client.getAllStrategies();
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
    };
    if (existing.length > 0) {
        console.log(`Safely resetting ${existing.length} existing strategies...`);
        for (const strategy of existing) {
            console.log(`  Resetting ${strategy.name}...`);
            const result = await resetStrategySafely(client, strategy._id);
            totals.strategies++;
            console.log(`    cancelled orders: ${result.cancelledOrders}`);
            console.log(`    closed positions: ${result.closedPositions}`);
            for (const key of Object.keys(result.deleted)) {
                if (key in totals) {
                    const numericTotals = totals;
                    numericTotals[key] += result.deleted[key];
                }
            }
        }
        console.log("Deleted:");
        printDeleteCounts(totals);
        console.log("");
    }
    console.log(`Importing ${strategies.length} strategies...`);
    for (const strategy of strategies) {
        await client.addStrategy(strategy);
        console.log(`  + ${strategy.name} (${strategy.app}, model=${getStrategyModel(strategy)})`);
    }
    console.log(`Imported ${strategies.length} strategies`);
});

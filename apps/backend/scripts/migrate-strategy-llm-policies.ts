import { migrateLegacyStrategyLlmPolicy, validateStrategyConfig } from "@valiq-trading/core"
import {
    createClient,
    getStrategyLlmSummary,
    resolveArg,
    runScript,
} from "./lib/strategy-cli"

runScript(async () => {
    const write = resolveArg("write") === "true"
    const client = createClient()
    const strategies = await client.getAllStrategies()
    let migrated = 0
    let skipped = 0

    for (const strategy of strategies) {
        if (!("model" in strategy.policy) && !("reasoning" in strategy.policy)) {
            skipped++
            console.log(`Skipped "${strategy.name}" (${getStrategyLlmSummary(strategy)})`)
            continue
        }

        const policy = migrateLegacyStrategyLlmPolicy(strategy.policy)
        const config = validateStrategyConfig({
            app: strategy.app,
            name: strategy.name,
            enabled: strategy.enabled,
            schedule: strategy.schedule,
            policy,
            context: strategy.context,
        })
        migrated++
        console.log(`${write ? "Migrating" : "Would migrate"} "${strategy.name}" (${getStrategyLlmSummary(config)})`)

        if (write) {
            await client.updateStrategy(strategy._id, config)
        }
    }

    console.log(`${write ? "Migrated" : "Would migrate"} ${migrated} strategies, skipped ${skipped}`)
    if (!write && migrated > 0) {
        console.log("Run again with --write=true to persist changes")
    }
})

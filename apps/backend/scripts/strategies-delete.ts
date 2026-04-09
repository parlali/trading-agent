import type { Id } from "@valiq-trading/convex"
import {
    createClient,
    resolveArg,
    printDeleteCounts,
    runScript,
} from "./lib/strategy-cli"
import { resetStrategySafely } from "./lib/safe-strategy-reset"

runScript(async () => {
    const idArg = resolveArg("id")
    const nameArg = resolveArg("name")

    if (!idArg && !nameArg) {
        throw new Error("Provide --id=<convex_id> or --name=<strategy_name>")
    }

    const client = createClient()

    let targetId: Id<"strategies">
    let targetName: string

    if (idArg) {
        targetId = idArg as Id<"strategies">
        const strategy = await client.getStrategyById(targetId)

        if (!strategy) {
            throw new Error(`Strategy not found: ${idArg}`)
        }

        targetName = strategy.name
    } else {
        const all = await client.getAllStrategies()
        const match = all.find(
            (s) => s.name.toLowerCase() === nameArg!.toLowerCase()
        )

        if (!match) {
            const available = all.map((s) => `  - ${s.name} (${s._id})`).join("\n")
            throw new Error(
                `Strategy "${nameArg}" not found in backend.\nExisting:\n${available}`
            )
        }

        targetId = match._id
        targetName = match.name
    }

    console.log(`Resetting "${targetName}" (${targetId})...`)

    const result = await resetStrategySafely(client, targetId)

    console.log(`Reset "${targetName}" and deleted Convex state:`)
    console.log(`  cancelled orders: ${result.cancelledOrders}`)
    console.log(`  closed positions: ${result.closedPositions}`)
    printDeleteCounts(result.deleted as never)
})

import type {
    CascadeDeleteCounts,
    DeleteAllStrategiesResult,
    StoredStrategy,
    TradingBackendClient,
} from "@valiq-trading/convex"
import {
    addDeleteCounts,
    createDeleteTotals,
} from "./strategy-cli"
import { resetStrategySafely } from "./safe-strategy-reset"

export async function resetExistingStrategies(
    client: TradingBackendClient,
    strategies: StoredStrategy[],
    messages: {
        empty: string
        reset: (count: number) => string
    }
): Promise<DeleteAllStrategiesResult> {
    const totals = createDeleteTotals()

    if (strategies.length === 0) {
        console.log(messages.empty)
        return totals
    }

    console.log(messages.reset(strategies.length))

    for (const strategy of strategies) {
        console.log(`  Resetting ${strategy.name}...`)
        const result = await resetStrategySafely(client, strategy._id)
        totals.strategies++
        console.log(`    cancelled orders: ${result.cancelledOrders}`)
        console.log(`    closed positions: ${result.closedPositions}`)
        addDeleteCounts(totals, result.deleted as CascadeDeleteCounts)
    }

    return totals
}

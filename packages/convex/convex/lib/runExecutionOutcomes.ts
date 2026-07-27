import type { DatabaseWriter } from "../_generated/server"
import type { Doc, Id } from "../_generated/dataModel"
import { isFilledOrderStatus, resolveOrderRealizedPnl } from "@valiq-trading/core"

const MAX_RUN_ORDER_ROWS = 64

export interface RunExecutionOutcomes {
    opportunitySubmitted: number
    opportunityFilled: number
    opportunityClosed: number
    opportunityRealizedPnl: number
}

export function computeRunExecutionOutcomes(
    orders: Array<Doc<"orders">>
): RunExecutionOutcomes {
    let submitted = 0
    let filled = 0
    let closed = 0
    let realizedPnl = 0

    for (const order of orders) {
        if (order.status !== "rejected") {
            submitted++
        }

        if (!isFilledOrderStatus(order.status)) {
            continue
        }

        filled++
        if (order.action === "close") {
            closed++
        }

        const realized = resolveOrderRealizedPnl(order)
        if (realized !== undefined) {
            realizedPnl += realized
        }
    }

    return {
        opportunitySubmitted: submitted,
        opportunityFilled: filled,
        opportunityClosed: closed,
        opportunityRealizedPnl: realizedPnl,
    }
}

export async function recomputeRunExecutionOutcomes(
    db: DatabaseWriter,
    runId: Id<"strategy_runs">
): Promise<RunExecutionOutcomes | undefined> {
    const run = await db.get(runId)
    if (!run) {
        return undefined
    }

    const orders = await db
        .query("orders")
        .withIndex("by_run", (q) => q.eq("runId", runId))
        .take(MAX_RUN_ORDER_ROWS)
    const outcomes = computeRunExecutionOutcomes(orders)

    if (
        run.opportunitySubmitted !== outcomes.opportunitySubmitted ||
        run.opportunityFilled !== outcomes.opportunityFilled ||
        run.opportunityClosed !== outcomes.opportunityClosed ||
        run.opportunityRealizedPnl !== outcomes.opportunityRealizedPnl
    ) {
        await db.patch(runId, { ...outcomes })
    }

    return outcomes
}

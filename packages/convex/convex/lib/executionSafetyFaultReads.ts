import type { Doc, Id } from "../_generated/dataModel"
import type { QueryCtx } from "../_generated/server"

type ExecutionSafetyFaultReadCtx = {
    db: {
        query: QueryCtx["db"]["query"]
    }
}

export async function collectBlockedExecutionSafetyFaultsForStrategy(
    ctx: ExecutionSafetyFaultReadCtx,
    args: {
        strategyId: Id<"strategies">
        app: Doc<"strategies">["app"]
        accountId: string
    }
): Promise<Array<Doc<"execution_safety_faults">>> {
    const [strategyFaults, accountFaults] = await Promise.all([
        ctx.db
            .query("execution_safety_faults")
            .withIndex("by_strategy_blocked", (q) => q.eq("strategyId", args.strategyId).eq("blocked", true))
            .collect(),
        ctx.db
            .query("execution_safety_faults")
            .withIndex("by_app_account_blocked", (q) =>
                q.eq("app", args.app).eq("accountId", args.accountId).eq("blocked", true)
            )
            .collect(),
    ])

    return [
        ...strategyFaults,
        ...accountFaults.filter((fault) => fault.strategyId === undefined),
    ]
}

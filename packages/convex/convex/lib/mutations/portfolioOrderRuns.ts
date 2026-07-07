import type { Id } from "../../_generated/dataModel"
import type { PortfolioMutationCtx } from "./portfolioTypes"

export async function resolveLatestRunIdForStrategy(
    ctx: PortfolioMutationCtx,
    strategyId: Id<"strategies">
): Promise<Id<"strategy_runs"> | undefined> {
    const run = await ctx.db
        .query("strategy_runs")
        .withIndex("by_strategy_started_at", (q) => q.eq("strategyId", strategyId))
        .order("desc")
        .first()

    return run?._id
}

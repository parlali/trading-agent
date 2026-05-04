import type { Id } from "../../_generated/dataModel"
import type { PortfolioMutationCtx } from "./portfolioTypes"

export async function resolveLatestRunIdForStrategy(
    ctx: PortfolioMutationCtx,
    strategyId: Id<"strategies">
): Promise<Id<"strategy_runs"> | undefined> {
    const runs = await ctx.db
        .query("strategy_runs")
        .withIndex("by_strategy", (q) => q.eq("strategyId", strategyId))
        .collect()

    return runs
        .sort((left, right) => right.startedAt - left.startedAt)[0]?._id
}

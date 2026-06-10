import type { Doc } from "../_generated/dataModel"
import type { MutationCtx } from "../_generated/server"

export async function incrementControlPlaneMetric(
    ctx: Pick<MutationCtx, "db">,
    args: {
        metric: string
        app?: Doc<"control_plane_metrics">["app"]
        delta?: number
    }
): Promise<void> {
    const now = Date.now()
    const delta = args.delta ?? 1
    if (delta === 0) {
        return
    }

    const existing = await ctx.db
        .query("control_plane_metrics")
        .withIndex("by_metric_app", (q) => q.eq("metric", args.metric).eq("app", args.app))
        .first()

    if (existing) {
        await ctx.db.patch(existing._id, {
            value: existing.value + delta,
            updatedAt: now,
        })
        return
    }

    await ctx.db.insert("control_plane_metrics", {
        metric: args.metric,
        app: args.app,
        value: delta,
        updatedAt: now,
    })
}

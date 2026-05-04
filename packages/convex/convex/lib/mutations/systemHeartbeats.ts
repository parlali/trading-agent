import { mutation } from "../../_generated/server"
import type { MutationCtx } from "../../_generated/server"
import type { Doc, Id } from "../../_generated/dataModel"
import { v } from "convex/values"
import { requireServiceToken } from "../authGuards"
import { appV, heartbeatStatusV } from "../validators"
import { incrementControlPlaneMetric } from "../controlPlaneMetrics"
import {
    composeHeartbeatReadModel,
    computeHeartbeatMetadataHash,
    type HeartbeatStatus,
} from "../heartbeatModel"

async function upsertHeartbeatLiveness(
    ctx: MutationCtx,
    args: {
        app: Doc<"app_heartbeats">["app"]
        status: HeartbeatStatus
        metadata?: unknown
        now: number
    }
): Promise<Doc<"app_heartbeat_liveness">> {
    const existing = await ctx.db
        .query("app_heartbeat_liveness")
        .withIndex("by_app", (q) => q.eq("app", args.app))
        .first()

    const payload = {
        app: args.app,
        status: args.status,
        metadata: args.metadata,
        lastHeartbeat: args.now,
        updatedAt: args.now,
    }

    if (existing) {
        await ctx.db.patch(existing._id, payload)
        return {
            ...existing,
            ...payload,
        }
    }

    const id = await ctx.db.insert("app_heartbeat_liveness", payload)
    return {
        _id: id,
        _creationTime: args.now,
        ...payload,
    }
}

async function upsertHeartbeatSnapshot(
    ctx: MutationCtx,
    args: {
        app: Doc<"app_heartbeats">["app"]
        status: HeartbeatStatus
        metadata: unknown
        force?: boolean
        now: number
    }
): Promise<{ snapshot: Doc<"app_heartbeat_snapshots">; written: boolean; suppressed: boolean }> {
    const metadataHash = computeHeartbeatMetadataHash(args.metadata)
    const existing = await ctx.db
        .query("app_heartbeat_snapshots")
        .withIndex("by_app", (q) => q.eq("app", args.app))
        .first()

    if (existing) {
        const unchanged = existing.metadataHash === metadataHash && existing.status === args.status

        if (unchanged && args.force !== true) {
            const suppressedWrites = existing.suppressedWrites + 1
            await ctx.db.patch(existing._id, {
                suppressedWrites,
                updatedAt: args.now,
            })

            return {
                snapshot: {
                    ...existing,
                    suppressedWrites,
                    updatedAt: args.now,
                },
                written: false,
                suppressed: true,
            }
        }

        const lastChangedAt = unchanged ? existing.lastChangedAt : args.now
        await ctx.db.patch(existing._id, {
            status: args.status,
            metadata: args.metadata,
            metadataHash,
            lastSnapshotAt: args.now,
            lastChangedAt,
            updatedAt: args.now,
        })

        return {
            snapshot: {
                ...existing,
                status: args.status,
                metadata: args.metadata,
                metadataHash,
                lastSnapshotAt: args.now,
                lastChangedAt,
                updatedAt: args.now,
            },
            written: true,
            suppressed: false,
        }
    }

    const id = await ctx.db.insert("app_heartbeat_snapshots", {
        app: args.app,
        status: args.status,
        metadata: args.metadata,
        metadataHash,
        lastSnapshotAt: args.now,
        lastChangedAt: args.now,
        suppressedWrites: 0,
        updatedAt: args.now,
    })

    return {
        snapshot: {
            _id: id,
            _creationTime: args.now,
            app: args.app,
            status: args.status,
            metadata: args.metadata,
            metadataHash,
            lastSnapshotAt: args.now,
            lastChangedAt: args.now,
            suppressedWrites: 0,
            updatedAt: args.now,
        },
        written: true,
        suppressed: false,
    }
}

async function upsertHeartbeatReadModel(
    ctx: MutationCtx,
    args: {
        app: Doc<"app_heartbeats">["app"]
        now: number
        liveness?: Doc<"app_heartbeat_liveness">
        snapshot?: Doc<"app_heartbeat_snapshots">
    }
): Promise<Id<"app_heartbeats">> {
    const liveness = args.liveness ?? await ctx.db
        .query("app_heartbeat_liveness")
        .withIndex("by_app", (q) => q.eq("app", args.app))
        .first()
    const snapshot = args.snapshot ?? await ctx.db
        .query("app_heartbeat_snapshots")
        .withIndex("by_app", (q) => q.eq("app", args.app))
        .first()

    const composed = composeHeartbeatReadModel({
        now: args.now,
        liveness: liveness
            ? {
                status: liveness.status,
                lastHeartbeat: liveness.lastHeartbeat,
                metadata: liveness.metadata,
            }
            : undefined,
        snapshot: snapshot
            ? {
                status: snapshot.status,
                lastSnapshotAt: snapshot.lastSnapshotAt,
                metadata: snapshot.metadata,
            }
            : undefined,
    })

    const existing = await ctx.db
        .query("app_heartbeats")
        .withIndex("by_app", (q) => q.eq("app", args.app))
        .first()

    const payload = {
        app: args.app,
        status: composed.status,
        metadata: composed.metadata,
        lastHeartbeat: composed.lastHeartbeat,
    }

    if (existing) {
        await ctx.db.patch(existing._id, payload)
        return existing._id
    }

    return await ctx.db.insert("app_heartbeats", payload)
}

export const reportHeartbeatLiveness = mutation({
    args: {
        serviceToken: v.string(),
        app: appV,
        status: heartbeatStatusV,
        metadata: v.optional(v.any()),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        const now = Date.now()
        const liveness = await upsertHeartbeatLiveness(ctx, {
            app: args.app,
            status: args.status,
            metadata: args.metadata,
            now,
        })
        const id = await upsertHeartbeatReadModel(ctx, {
            app: args.app,
            now,
            liveness,
        })
        await incrementControlPlaneMetric(ctx, {
            metric: "heartbeat.liveness_write",
            app: args.app,
        })

        return {
            heartbeatId: id,
            app: args.app,
            status: args.status,
            lastHeartbeat: now,
        }
    },
})

export const reportHeartbeatSnapshot = mutation({
    args: {
        serviceToken: v.string(),
        app: appV,
        status: heartbeatStatusV,
        metadata: v.any(),
        force: v.optional(v.boolean()),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        const now = Date.now()
        const snapshotResult = await upsertHeartbeatSnapshot(ctx, {
            app: args.app,
            status: args.status,
            metadata: args.metadata,
            force: args.force,
            now,
        })

        const id = await upsertHeartbeatReadModel(ctx, {
            app: args.app,
            now,
            snapshot: snapshotResult.snapshot,
        })
        await incrementControlPlaneMetric(ctx, {
            metric: snapshotResult.suppressed ? "heartbeat.snapshot_suppressed" : "heartbeat.snapshot_written",
            app: args.app,
        })

        return {
            heartbeatId: id,
            app: args.app,
            status: args.status,
            written: snapshotResult.written,
            suppressed: snapshotResult.suppressed,
            metadataHash: snapshotResult.snapshot.metadataHash,
            lastSnapshotAt: snapshotResult.snapshot.lastSnapshotAt,
            suppressedWrites: snapshotResult.snapshot.suppressedWrites,
        }
    },
})

export const reportHeartbeat = mutation({
    args: {
        serviceToken: v.string(),
        app: appV,
        status: heartbeatStatusV,
        metadata: v.optional(v.any()),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        const now = Date.now()
        const liveness = await upsertHeartbeatLiveness(ctx, {
            app: args.app,
            status: args.status,
            metadata: undefined,
            now,
        })

        let snapshot: Doc<"app_heartbeat_snapshots"> | undefined
        if (args.metadata !== undefined) {
            const snapshotResult = await upsertHeartbeatSnapshot(ctx, {
                app: args.app,
                status: args.status,
                metadata: args.metadata,
                now,
            })
            snapshot = snapshotResult.snapshot
        }

        return await upsertHeartbeatReadModel(ctx, {
            app: args.app,
            now,
            liveness,
            snapshot,
        })
    },
})

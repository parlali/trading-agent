import { mutation } from "../../_generated/server"
import type { MutationCtx } from "../../_generated/server"
import type { Doc, Id } from "../../_generated/dataModel"
import { v } from "convex/values"
import { requireUser, requireServiceToken } from "../authGuards"
import { appV, venueAppV } from "../validators"
import { createEmptyCascadeDeleteCounts } from "../cascadeDelete"
import type { App } from "@valiq-trading/core"
import { incrementControlPlaneMetric } from "../controlPlaneMetrics"
import { composeHeartbeatReadModel, computeHeartbeatMetadataHash, type HeartbeatStatus } from "../heartbeatModel"

export const createAlert = mutation({
    args: {
        serviceToken: v.string(),
        strategyId: v.optional(v.id("strategies")),
        app: v.optional(
            v.union(
                v.literal("alpaca-options"),
                v.literal("polymarket"),
                v.literal("mt5"),
                v.literal("binance-futures"),
                v.literal("backend")
            )
        ),
        severity: v.union(
            v.literal("critical"),
            v.literal("warning"),
            v.literal("info")
        ),
        message: v.string(),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        await ctx.db.insert("alerts", {
            strategyId: args.strategyId,
            app: args.app,
            severity: args.severity,
            message: args.message,
            acknowledged: false,
            timestamp: Date.now(),
        })
    },
})

export const acknowledgeAlert = mutation({
    args: {
        alertId: v.id("alerts"),
    },
    handler: async (ctx, args) => {
        await requireUser(ctx)
        await ctx.db.patch(args.alertId, {
            acknowledged: true,
        })
    },
})

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
        status: v.union(
            v.literal("healthy"),
            v.literal("degraded"),
            v.literal("unhealthy")
        ),
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
        status: v.union(
            v.literal("healthy"),
            v.literal("degraded"),
            v.literal("unhealthy")
        ),
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
        status: v.union(
            v.literal("healthy"),
            v.literal("degraded"),
            v.literal("unhealthy")
        ),
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

export const snapshotAccountState = mutation({
    args: {
        serviceToken: v.string(),
        app: v.union(
            v.literal("alpaca-options"),
            v.literal("polymarket"),
            v.literal("mt5"),
            v.literal("binance-futures"),
            v.literal("backend")
        ),
        venue: v.string(),
        balance: v.number(),
        equity: v.optional(v.number()),
        buyingPower: v.number(),
        marginUsed: v.number(),
        marginAvailable: v.number(),
        openPnl: v.number(),
        dayPnl: v.number(),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        return await ctx.db.insert("account_snapshots", {
            app: args.app,
            venue: args.venue,
            balance: args.balance,
            equity: args.equity,
            buyingPower: args.buyingPower,
            marginUsed: args.marginUsed,
            marginAvailable: args.marginAvailable,
            openPnl: args.openPnl,
            dayPnl: args.dayPnl,
            timestamp: Date.now(),
        })
    },
})

export const setKillSwitch = mutation({
    args: {
        scope: v.union(
            v.literal("global"),
            v.literal("alpaca-options"),
            v.literal("polymarket"),
            v.literal("mt5"),
            v.literal("binance-futures")
        ),
        enabled: v.boolean(),
        updatedBy: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        await requireUser(ctx)
        const existing = await ctx.db
            .query("system_state")
            .withIndex("by_key", (q) => q.eq("key", "kill_switches"))
            .first()

        const now = Date.now()

        if (!existing) {
            const state = {
                key: "kill_switches" as const,
                globalKillSwitch: args.scope === "global" ? args.enabled : false,
                appKillSwitches: {
                    alpaca_options: args.scope === "alpaca-options" ? args.enabled : false,
                    polymarket: args.scope === "polymarket" ? args.enabled : false,
                    mt5: args.scope === "mt5" ? args.enabled : false,
                    binance_futures: args.scope === "binance-futures" ? args.enabled : false,
                },
                updatedAt: now,
                updatedBy: args.updatedBy,
            }
            return await ctx.db.insert("system_state", state)
        }

        if (args.scope === "global") {
            await ctx.db.patch(existing._id, {
                globalKillSwitch: args.enabled,
                updatedAt: now,
                updatedBy: args.updatedBy,
            })
        } else {
            const killSwitchKey = args.scope.replace(/-/g, "_") as keyof typeof existing.appKillSwitches
            await ctx.db.patch(existing._id, {
                appKillSwitches: {
                    ...existing.appKillSwitches,
                    [killSwitchKey]: args.enabled,
                },
                updatedAt: now,
                updatedBy: args.updatedBy,
            })
        }

        return existing._id
    },
})

export const clearManualRunRequest = mutation({
    args: {
        serviceToken: v.string(),
        requestId: v.id("manual_run_requests"),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)
        await ctx.db.delete(args.requestId)
    },
})

const DEFAULT_MANUAL_RUN_LEASE_MS = 30_000
const MAX_MANUAL_RUN_LEASE_MS = 5 * 60 * 1000
const DEFAULT_MANUAL_RUN_CLAIM_LIMIT = 25
const MAX_MANUAL_RUN_CLAIM_LIMIT = 100
const DEFAULT_MANUAL_RUN_MAX_ATTEMPTS = 5
const MAX_MANUAL_RUN_MAX_ATTEMPTS = 20

export const claimManualRunRequests = mutation({
    args: {
        serviceToken: v.string(),
        app: venueAppV,
        workerId: v.string(),
        leaseMs: v.optional(v.number()),
        maxClaims: v.optional(v.number()),
        maxAttempts: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)

        const now = Date.now()
        const leaseMs = Math.max(1_000, Math.min(args.leaseMs ?? DEFAULT_MANUAL_RUN_LEASE_MS, MAX_MANUAL_RUN_LEASE_MS))
        const maxClaims = Math.max(1, Math.min(args.maxClaims ?? DEFAULT_MANUAL_RUN_CLAIM_LIMIT, MAX_MANUAL_RUN_CLAIM_LIMIT))
        const maxAttempts = Math.max(1, Math.min(args.maxAttempts ?? DEFAULT_MANUAL_RUN_MAX_ATTEMPTS, MAX_MANUAL_RUN_MAX_ATTEMPTS))

        const pending = await ctx.db
            .query("manual_run_requests")
            .withIndex("by_app_terminal_requested_at", (q) =>
                q.eq("app", args.app).eq("terminalAt", undefined)
            )
            .order("asc")
            .take(Math.max(maxClaims * 4, maxClaims))

        const claimed: Array<{
            _id: Id<"manual_run_requests">
            strategyId: Id<"strategies">
            app: Doc<"manual_run_requests">["app"]
            requestedAt: number
            attemptCount: number
            leaseExpiresAt: number
        }> = []

        let contentionCount = 0
        let terminalizedCount = 0

        for (const request of pending) {
            if (claimed.length >= maxClaims) {
                break
            }

            const leaseActive = request.leaseExpiresAt !== undefined && request.leaseExpiresAt > now
            if (request.claimedBy && request.claimedBy !== args.workerId && leaseActive) {
                contentionCount++
                continue
            }

            if (request.attemptCount >= maxAttempts) {
                await ctx.db.patch(request._id, {
                    claimedBy: undefined,
                    leaseExpiresAt: undefined,
                    terminalAt: now,
                    lastError: request.lastError ?? `Manual run request exceeded max attempts (${maxAttempts})`,
                })
                terminalizedCount++
                continue
            }

            const leaseExpiresAt = now + leaseMs

            await ctx.db.patch(request._id, {
                claimedBy: args.workerId,
                leaseExpiresAt,
            })

            claimed.push({
                _id: request._id,
                strategyId: request.strategyId,
                app: request.app,
                requestedAt: request.requestedAt,
                attemptCount: request.attemptCount,
                leaseExpiresAt,
            })
        }

        await incrementControlPlaneMetric(ctx, {
            metric: "manual_run.claim_attempt",
            app: args.app,
        })
        if (claimed.length > 0) {
            await incrementControlPlaneMetric(ctx, {
                metric: "manual_run.claimed",
                app: args.app,
                delta: claimed.length,
            })
        }
        if (contentionCount > 0) {
            await incrementControlPlaneMetric(ctx, {
                metric: "manual_run.claim_contention",
                app: args.app,
                delta: contentionCount,
            })
        }
        if (terminalizedCount > 0) {
            await incrementControlPlaneMetric(ctx, {
                metric: "manual_run.terminalized_on_claim",
                app: args.app,
                delta: terminalizedCount,
            })
        }

        return {
            app: args.app,
            claimed,
            contentionCount,
            terminalizedCount,
            maxAttempts,
            leaseMs,
        }
    },
})

export const ackManualRunRequest = mutation({
    args: {
        serviceToken: v.string(),
        requestId: v.id("manual_run_requests"),
        workerId: v.string(),
        outcome: v.union(
            v.literal("completed"),
            v.literal("requeue"),
            v.literal("retryable_failure"),
            v.literal("terminal_failure")
        ),
        error: v.optional(v.string()),
        maxAttempts: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)

        const now = Date.now()
        const maxAttempts = Math.max(1, Math.min(args.maxAttempts ?? DEFAULT_MANUAL_RUN_MAX_ATTEMPTS, MAX_MANUAL_RUN_MAX_ATTEMPTS))
        const request = await ctx.db.get(args.requestId)
        if (!request) {
            return { status: "missing" as const }
        }

        if (request.terminalAt) {
            return { status: "already_terminal" as const }
        }

        if (request.claimedBy !== args.workerId) {
            throw new Error(`Manual run request ${args.requestId} is not claimed by worker ${args.workerId}`)
        }

        if (args.outcome === "completed") {
            await ctx.db.delete(args.requestId)
            await incrementControlPlaneMetric(ctx, {
                metric: "manual_run.ack_completed",
                app: request.app,
            })
            return { status: "completed" as const }
        }

        if (args.outcome === "requeue") {
            await ctx.db.patch(args.requestId, {
                claimedBy: undefined,
                leaseExpiresAt: undefined,
                lastError: args.error ?? request.lastError,
            })
            await incrementControlPlaneMetric(ctx, {
                metric: "manual_run.ack_requeue",
                app: request.app,
            })
            return { status: "requeue" as const }
        }

        if (args.outcome === "terminal_failure") {
            await ctx.db.patch(args.requestId, {
                claimedBy: undefined,
                leaseExpiresAt: undefined,
                terminalAt: now,
                lastError: args.error ?? request.lastError ?? "Manual run request failed terminally",
            })
            await incrementControlPlaneMetric(ctx, {
                metric: "manual_run.ack_terminal_failure",
                app: request.app,
            })
            return { status: "terminal_failure" as const }
        }

        const nextAttemptCount = request.attemptCount + 1
        if (nextAttemptCount >= maxAttempts) {
            await ctx.db.patch(args.requestId, {
                claimedBy: undefined,
                leaseExpiresAt: undefined,
                attemptCount: nextAttemptCount,
                terminalAt: now,
                lastError: args.error ?? request.lastError ?? `Manual run request exceeded max attempts (${maxAttempts})`,
            })
            await incrementControlPlaneMetric(ctx, {
                metric: "manual_run.ack_terminal_failure",
                app: request.app,
            })
            return { status: "terminal_failure" as const }
        }

        await ctx.db.patch(args.requestId, {
            claimedBy: undefined,
            leaseExpiresAt: undefined,
            attemptCount: nextAttemptCount,
            lastError: args.error ?? request.lastError,
        })
        await incrementControlPlaneMetric(ctx, {
            metric: "manual_run.ack_retryable_failure",
            app: request.app,
        })

        return { status: "retryable_failure" as const }
    },
})

export const clearFullResetState = mutation({
    args: {
        serviceToken: v.string(),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)

        const deleted = {
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
        }

        const providerSyncStates = await ctx.db.query("provider_sync_state").collect()
        for (const state of providerSyncStates) {
            await ctx.db.delete(state._id)
            deleted.providerSyncStates++
        }

        const snapshots = await ctx.db.query("account_snapshots").collect()
        for (const snapshot of snapshots) {
            await ctx.db.delete(snapshot._id)
            deleted.accountSnapshots++
        }

        const heartbeats = await ctx.db.query("app_heartbeats").collect()
        for (const heartbeat of heartbeats) {
            await ctx.db.delete(heartbeat._id)
            deleted.appHeartbeats++
        }

        const livenessRows = await ctx.db.query("app_heartbeat_liveness").collect()
        for (const row of livenessRows) {
            await ctx.db.delete(row._id)
            deleted.appHeartbeats++
        }

        const snapshotRows = await ctx.db.query("app_heartbeat_snapshots").collect()
        for (const row of snapshotRows) {
            await ctx.db.delete(row._id)
            deleted.appHeartbeats++
        }

        const metrics = await ctx.db.query("control_plane_metrics").collect()
        for (const metric of metrics) {
            await ctx.db.delete(metric._id)
        }

        const alerts = await ctx.db.query("alerts").collect()
        for (const alert of alerts) {
            await ctx.db.delete(alert._id)
            deleted.alerts++
        }

        return deleted
    },
})

export const clearFullResetStateBatch = mutation({
    args: {
        serviceToken: v.string(),
        batchSize: v.optional(v.number()),
        preserveApps: v.optional(v.array(appV)),
    },
    handler: async (ctx, args) => {
        requireServiceToken(args.serviceToken)

        const batchSize = Math.max(1, Math.min(args.batchSize ?? 20, 50))
        await incrementControlPlaneMetric(ctx, {
            metric: "maintenance.full_reset_batch.invocation",
        })
        await incrementControlPlaneMetric(ctx, {
            metric: "maintenance.full_reset_batch.batch_size",
            delta: batchSize,
        })
        const preserveApps = new Set<App>(args.preserveApps ?? [])
        const deleted = createEmptyCascadeDeleteCounts()
        const venueApps = [
            "alpaca-options",
            "polymarket",
            "mt5",
            "binance-futures",
        ] as const
        const apps = [
            ...venueApps,
            "backend",
        ] as const

        for (const app of venueApps) {
            if (preserveApps.has(app)) {
                continue
            }

            const providerSyncState = await ctx.db
                .query("provider_sync_state")
                .withIndex("by_app", (q) => q.eq("app", app))
                .first()

            if (providerSyncState) {
                await ctx.db.delete(providerSyncState._id)
                deleted.providerSyncStates++
                return {
                    ...deleted,
                    hasMore: true,
                }
            }
        }

        for (const app of apps) {
            if (preserveApps.has(app)) {
                continue
            }

            const liveness = await ctx.db
                .query("app_heartbeat_liveness")
                .withIndex("by_app", (q) => q.eq("app", app))
                .first()

            if (liveness) {
                await ctx.db.delete(liveness._id)
                deleted.appHeartbeats++
                return {
                    ...deleted,
                    hasMore: true,
                }
            }
        }

        for (const app of apps) {
            if (preserveApps.has(app)) {
                continue
            }

            const snapshot = await ctx.db
                .query("app_heartbeat_snapshots")
                .withIndex("by_app", (q) => q.eq("app", app))
                .first()

            if (snapshot) {
                await ctx.db.delete(snapshot._id)
                deleted.appHeartbeats++
                return {
                    ...deleted,
                    hasMore: true,
                }
            }
        }

        for (const app of apps) {
            if (preserveApps.has(app)) {
                continue
            }

            const snapshots = await ctx.db
                .query("account_snapshots")
                .withIndex("by_app", (q) => q.eq("app", app))
                .take(batchSize)

            if (snapshots.length > 0) {
                for (const snapshot of snapshots) {
                    await ctx.db.delete(snapshot._id)
                    deleted.accountSnapshots++
                }

                return {
                    ...deleted,
                    hasMore: true,
                }
            }
        }

        for (const app of apps) {
            if (preserveApps.has(app)) {
                continue
            }

            const heartbeat = await ctx.db
                .query("app_heartbeats")
                .withIndex("by_app", (q) => q.eq("app", app))
                .first()

            if (heartbeat) {
                await ctx.db.delete(heartbeat._id)
                deleted.appHeartbeats++
                return {
                    ...deleted,
                    hasMore: true,
                }
            }
        }

        if (preserveApps.size === 0) {
            const alerts = await ctx.db.query("alerts").order("asc").take(batchSize)

            if (alerts.length > 0) {
                for (const alert of alerts) {
                    await ctx.db.delete(alert._id)
                    deleted.alerts++
                }

                return {
                    ...deleted,
                    hasMore: true,
                }
            }

            const metrics = await ctx.db.query("control_plane_metrics").order("asc").take(batchSize)
            if (metrics.length > 0) {
                for (const metric of metrics) {
                    await ctx.db.delete(metric._id)
                }
                return {
                    ...deleted,
                    hasMore: true,
                }
            }
        }

        return {
            ...deleted,
            hasMore: false,
        }
    },
})

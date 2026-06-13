import { describe, expect, it } from "vitest"
import {
    createOrderSnapshot,
    isStaleTerminalOrderRegression,
    updateOrderSnapshotFromExecution,
} from "./orders"
import type { OrderIntent } from "./order-intent-types"

const intent: OrderIntent = {
    instrument: "US30",
    side: "buy",
    quantity: 0.1,
    orderType: "market",
    timeInForce: "ioc",
}

function createFilledSnapshot() {
    return createOrderSnapshot({
        strategyId: "strategy-1",
        runId: "run-1",
        venue: "mt5",
        action: "entry",
        intent,
        result: {
            orderId: "vmte01abcdefghij",
            canonicalOrderId: "vmte01abcdefghij",
            providerOrderId: "1671367552",
            status: "filled",
            filledQuantity: 0.1,
            fillPrice: 50659.1,
            timestamp: 2_000,
        },
        pollIntervalMs: 5_000,
        timeoutMs: 120_000,
        now: 2_000,
    })
}

describe("updateOrderSnapshotFromExecution terminal-state guard", () => {
    it("ignores a stale non-terminal result once the snapshot is provider-confirmed terminal", () => {
        const snapshot = createFilledSnapshot()

        const updated = updateOrderSnapshotFromExecution(snapshot, {
            orderId: "1671367552",
            status: "pending",
            filledQuantity: 0,
            timestamp: 3_000,
        })

        expect(updated.status).toBe("filled")
        expect(updated.filledQuantity).toBe(0.1)
        expect(updated.avgFillPrice).toBe(50659.1)
        expect(updated.polling.lastCheckedAt).toBe(3_000)
    })

    it("still applies terminal-to-terminal provider corrections", () => {
        const snapshot = createFilledSnapshot()

        const updated = updateOrderSnapshotFromExecution(snapshot, {
            orderId: "1671367552",
            status: "cancelled",
            filledQuantity: 0,
            timestamp: 3_000,
        })

        expect(updated.status).toBe("cancelled")
    })

    it("keeps provider-confirmed terminal truth when an operation attempt ends commit-unknown", () => {
        const snapshot = createFilledSnapshot()

        const updated = updateOrderSnapshotFromExecution(snapshot, {
            orderId: "1671367552",
            status: "filled",
            commitOutcome: "commit_unknown",
            filledQuantity: 0.1,
            timestamp: 3_000,
            error: "socket closed before cancel acknowledgement",
        })

        expect(updated.status).toBe("filled")
        expect(updated.commitOutcome).toBe("accepted")
        expect(updated.avgFillPrice).toBe(50659.1)
        expect(updated.polling.lastCheckedAt).toBe(3_000)
        expect(updated.polling.lastError).toBe("socket closed before cancel acknowledgement")
    })

    it("lets commit-unknown snapshots progress to recovered provider truth", () => {
        const snapshot = {
            ...createFilledSnapshot(),
            status: "rejected" as const,
            commitOutcome: "commit_unknown" as const,
        }

        const updated = updateOrderSnapshotFromExecution(snapshot, {
            orderId: "1671367552",
            status: "pending",
            filledQuantity: 0,
            commitOutcome: "recovered",
            timestamp: 3_000,
        })

        expect(updated.status).toBe("pending")
        expect(updated.commitOutcome).toBe("recovered")
    })

    it("persists provider accounting occurrence time when accounting metadata is present", () => {
        const snapshot = createFilledSnapshot()

        const updated = updateOrderSnapshotFromExecution(snapshot, {
            orderId: "1671367552",
            status: "filled",
            filledQuantity: 0.1,
            timestamp: 3_000,
            intentUpdates: {
                metadata: {
                    providerAccountingSource: "okx_order",
                    fee: -1.23,
                    feeCcy: "USDT",
                },
            },
        })

        expect(updated.intent.metadata).toMatchObject({
            providerAccountingSource: "okx_order",
            providerAccountingOccurredAt: 3_000,
        })
    })

    it("persists accounting metadata on immediately filled order snapshots", () => {
        const snapshot = createOrderSnapshot({
            strategyId: "strategy-1",
            runId: "run-1",
            venue: "okx",
            action: "entry",
            intent,
            result: {
                orderId: "vokm01abcdefghij",
                canonicalOrderId: "vokm01abcdefghij",
                providerOrderId: "9000000000000000001",
                status: "filled",
                filledQuantity: 0.1,
                fillPrice: 50659.1,
                timestamp: 4_000,
                intentUpdates: {
                    metadata: {
                        providerAccountingSource: "okx_order",
                        fee: -1.23,
                        feeCcy: "USDT",
                    },
                },
            },
            pollIntervalMs: 5_000,
            timeoutMs: 120_000,
        })

        expect(snapshot.intent.metadata).toMatchObject({
            providerAccountingSource: "okx_order",
            providerAccountingOccurredAt: 4_000,
        })
    })
})

describe("isStaleTerminalOrderRegression", () => {
    it("flags non-terminal writes over provider-confirmed terminal states", () => {
        expect(isStaleTerminalOrderRegression({ status: "filled", commitOutcome: "accepted" }, "pending")).toBe(true)
        expect(isStaleTerminalOrderRegression({ status: "cancelled", commitOutcome: "accepted" }, "partially_filled")).toBe(true)
    })

    it("does not flag recoverable or forward transitions", () => {
        expect(isStaleTerminalOrderRegression({ status: "timed_out", commitOutcome: "accepted" }, "pending")).toBe(false)
        expect(isStaleTerminalOrderRegression({ status: "rejected", commitOutcome: "commit_unknown" }, "pending")).toBe(false)
        expect(isStaleTerminalOrderRegression({ status: "pending", commitOutcome: "accepted" }, "filled")).toBe(false)
        expect(isStaleTerminalOrderRegression({ status: "filled", commitOutcome: "accepted" }, "cancelled")).toBe(false)
    })
})

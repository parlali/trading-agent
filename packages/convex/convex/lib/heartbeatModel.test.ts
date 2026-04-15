import { describe, expect, it } from "vitest"
import {
    composeHeartbeatReadModel,
    computeHeartbeatMetadataHash,
    mergeHeartbeatStatus,
} from "./heartbeatModel"

describe("heartbeatModel", () => {
    it("uses unhealthy as highest precedence during status composition", () => {
        expect(mergeHeartbeatStatus("healthy", "degraded")).toBe("degraded")
        expect(mergeHeartbeatStatus("degraded", "unhealthy")).toBe("unhealthy")
        expect(mergeHeartbeatStatus("healthy", "healthy")).toBe("healthy")
    })

    it("prefers snapshot metadata while preserving liveness timestamp", () => {
        const composed = composeHeartbeatReadModel({
            now: 1000,
            liveness: {
                status: "healthy",
                lastHeartbeat: 900,
                metadata: { source: "liveness" },
            },
            snapshot: {
                status: "degraded",
                lastSnapshotAt: 800,
                metadata: { source: "snapshot", driftDetected: true },
            },
        })

        expect(composed.status).toBe("degraded")
        expect(composed.lastHeartbeat).toBe(900)
        expect(composed.metadata).toEqual({ source: "snapshot", driftDetected: true })
    })

    it("produces stable metadata hashes regardless of object key order", () => {
        const left = computeHeartbeatMetadataHash({
            source: "periodic_sync",
            counts: {
                positions: 2,
                pendingOrders: 1,
            },
        })
        const right = computeHeartbeatMetadataHash({
            counts: {
                pendingOrders: 1,
                positions: 2,
            },
            source: "periodic_sync",
        })

        expect(left).toBe(right)
    })
})

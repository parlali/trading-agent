import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = {
    backend: {
        reportHeartbeatLiveness: vi.fn(),
        reportHeartbeatSnapshot: vi.fn(),
        createAlert: vi.fn(),
    },
    logger: {
        error: vi.fn(),
        info: vi.fn(),
    },
}

vi.mock("./state", () => ({
    backend: mocks.backend,
    logger: mocks.logger,
}))

describe("health-write", () => {
    beforeEach(() => {
        mocks.backend.reportHeartbeatLiveness.mockReset()
        mocks.backend.reportHeartbeatSnapshot.mockReset()
        mocks.backend.createAlert.mockReset()
        mocks.logger.error.mockReset()
        mocks.logger.info.mockReset()
    })

    it("retries liveness writes with bounded attempts", async () => {
        const { writeHeartbeatLiveness } = await import("./health-write.ts")
        mocks.backend.reportHeartbeatLiveness
            .mockRejectedValueOnce(new Error("temporary failure"))
            .mockResolvedValueOnce(undefined)

        await writeHeartbeatLiveness({
            app: "backend",
            status: "healthy",
            metadata: {
                source: "test",
            },
        })

        expect(mocks.backend.reportHeartbeatLiveness).toHaveBeenCalledTimes(2)
        expect(mocks.backend.createAlert).not.toHaveBeenCalled()
    })

    it("records suppression info for idempotent snapshot writes", async () => {
        const { writeHeartbeatSnapshot } = await import("./health-write.ts")
        mocks.backend.reportHeartbeatSnapshot.mockResolvedValue({
            written: false,
            suppressed: true,
            metadataHash: "abc123",
            lastSnapshotAt: Date.now(),
            suppressedWrites: 7,
        })

        await writeHeartbeatSnapshot({
            app: "polymarket",
            status: "healthy",
            metadata: {
                source: "periodic_sync",
            },
        })

        expect(mocks.logger.info).toHaveBeenCalledWith(
            "Heartbeat snapshot write suppressed by hash gate",
            expect.objectContaining({
                app: "polymarket",
                metadataHash: "abc123",
                suppressedWrites: 7,
            })
        )
    })

    it("alerts when all snapshot write attempts fail", async () => {
        const { writeHeartbeatSnapshot } = await import("./health-write.ts")
        mocks.backend.reportHeartbeatSnapshot.mockRejectedValue(new Error("convex unavailable"))
        mocks.backend.createAlert.mockResolvedValue(undefined)

        await writeHeartbeatSnapshot({
            app: "mt5",
            status: "degraded",
            metadata: {
                source: "periodic_sync",
                error: "convex unavailable",
            },
        })

        expect(mocks.backend.reportHeartbeatSnapshot).toHaveBeenCalledTimes(3)
        expect(mocks.backend.createAlert).toHaveBeenCalledWith({
            app: "mt5",
            severity: "warning",
            message: expect.stringContaining("Heartbeat snapshot write failed for mt5"),
        })
    })
})

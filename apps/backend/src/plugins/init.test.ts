import { describe, expect, it, vi } from "vitest"
import { validateVenueEnvironments } from "../environment-validation"
import type { HealthState, VenueApp, VenueHealthState, VenuePlugin } from "../types"

function createHealthState(): HealthState {
    return {
        ready: false,
        startedAt: 0,
        strategyCount: 0,
        venues: {},
    }
}

describe("validateVenueEnvironments", () => {
    it("retries failed validation and recovers automatically on the next pass", async () => {
        const validateEnvironment = vi.fn()
            .mockRejectedValueOnce(new Error("missing secret"))
            .mockResolvedValueOnce(undefined)
        const reportHeartbeat = vi.fn().mockResolvedValue(undefined)
        const createAlert = vi.fn().mockResolvedValue(undefined)
        const healthState = createHealthState()

        const dependencies = {
            createAlert,
            getPlugin(app: VenueApp): VenuePlugin | undefined {
                if (app !== "mt5") {
                    return undefined
                }

                return {
                    app,
                    venueName: "mt5",
                    resolveSecretKeys: () => [],
                    validateEnvironment,
                    createVenueAdapter: vi.fn() as unknown as VenuePlugin["createVenueAdapter"],
                    getRiskValidators: () => [],
                    getExtraTools: () => [],
                }
            },
            async getRequiredApps(): Promise<VenueApp[]> {
                return ["mt5"]
            },
            getValidationSecrets: () => ({
                MT5_LOGIN: "demo",
            }),
            healthState,
            logger: {
                error: vi.fn(),
                info: vi.fn(),
            },
            reportHeartbeat,
        }

        await validateVenueEnvironments(["mt5"], dependencies)

        expect(validateEnvironment).toHaveBeenCalledTimes(1)
        expect(healthState.venues.mt5).toEqual({
            validated: false,
            error: "missing secret",
        } satisfies VenueHealthState)
        expect(createAlert).toHaveBeenCalledTimes(1)
        expect(reportHeartbeat).toHaveBeenCalledWith("mt5", "degraded", {
            source: "environment_validation",
            error: "missing secret",
        })

        await validateVenueEnvironments(["mt5"], dependencies)

        expect(validateEnvironment).toHaveBeenCalledTimes(2)
        expect(healthState.venues.mt5).toEqual({
            validated: true,
        } satisfies VenueHealthState)
        expect(reportHeartbeat).toHaveBeenLastCalledWith("mt5", "healthy", {
            source: "environment_validation",
        })
    })
})

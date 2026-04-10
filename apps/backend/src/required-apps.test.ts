import { describe, expect, it } from "vitest"
import { getRequiredVenueApps } from "./required-apps"
import type { VenueApp } from "./types"

describe("getRequiredVenueApps", () => {
    const apps: VenueApp[] = ["alpaca-options", "polymarket", "mt5"]

    it("returns only venues that currently have registered strategies", () => {
        const required = getRequiredVenueApps(apps, {
            "alpaca-options": [{ strategyId: "alpaca-1" }],
            "mt5": [],
        })

        expect(required).toEqual(["alpaca-options"])
    })

    it("returns an empty list when no venues are currently required", () => {
        expect(getRequiredVenueApps(apps, {})).toEqual([])
    })

    it("keeps zero-strategy venues required when live provider exposure exists", () => {
        const required = getRequiredVenueApps(apps, {}, [
            {
                app: "polymarket",
                providerStatus: "healthy",
                stale: false,
                driftDetected: false,
                positionCount: 1,
                pendingOrderCount: 0,
                lastSyncedAt: 1,
                lastVerifiedAt: 1,
            },
        ])

        expect(required).toEqual(["polymarket"])
    })

    it("keeps zero-strategy venues required when provider state is degraded", () => {
        const required = getRequiredVenueApps(apps, {}, [
            {
                app: "mt5",
                providerStatus: "degraded",
                stale: false,
                driftDetected: false,
                positionCount: 0,
                pendingOrderCount: 0,
                lastError: "auth failed",
            },
        ])

        expect(required).toEqual(["mt5"])
    })

    it("does not require venues from default empty freshness rows alone", () => {
        const required = getRequiredVenueApps(apps, {}, [
            {
                app: "mt5",
                providerStatus: "stale",
                stale: true,
                driftDetected: false,
                positionCount: 0,
                pendingOrderCount: 0,
            },
        ])

        expect(required).toEqual([])
    })
})

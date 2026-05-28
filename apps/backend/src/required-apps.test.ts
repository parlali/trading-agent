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

    it("keeps zero-strategy venues required for live exposure or degraded provider state", () => {
        expect(getRequiredVenueApps(apps, {}, [
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
        ])).toEqual(["polymarket"])

        expect(getRequiredVenueApps(apps, {}, [
            {
                app: "mt5",
                providerStatus: "degraded",
                stale: false,
                driftDetected: false,
                positionCount: 0,
                pendingOrderCount: 0,
                lastError: "auth failed",
            },
        ])).toEqual(["mt5"])
    })
})

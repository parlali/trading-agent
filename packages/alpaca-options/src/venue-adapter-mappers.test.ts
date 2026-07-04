import { describe, expect, it } from "vitest"
import type { AlpacaAccountActivity } from "./alpaca-client"
import {
    mapAlpacaAccountPnlEvent,
    mapAlpacaOptionActivityClosure,
} from "./venue-adapter-mappers"

function activity(overrides: Partial<AlpacaAccountActivity>): AlpacaAccountActivity {
    return {
        id: "activity-1",
        activity_type: "OPEXP",
        transaction_time: "2026-06-27T00:00:00Z",
        status: "executed",
        ...overrides,
    }
}

describe("mapAlpacaOptionActivityClosure", () => {
    it("omits fillPnl for zero-cash expirations so realized PnL falls back to prices", () => {
        const closure = mapAlpacaOptionActivityClosure(activity({
            activity_type: "OPEXP",
            symbol: "SPY260626P00730000",
            qty: "1",
            price: "0",
            net_amount: "0",
        }))

        expect(closure).toBeDefined()
        expect(closure?.fillPrice).toBe(0)
        expect(closure?.metadata).not.toHaveProperty("fillPnl")
        expect(closure?.metadata?.netAmount).toBe(0)
    })

    it("keeps fillPnl when the activity carries realized cash", () => {
        const closure = mapAlpacaOptionActivityClosure(activity({
            activity_type: "OPEXC",
            symbol: "SPY260626P00730000",
            qty: "-1",
            price: "1.25",
            net_amount: "-125",
        }))

        expect(closure?.metadata?.fillPnl).toBe(-125)
    })
})

describe("mapAlpacaAccountPnlEvent", () => {
    it("maps fee-family activities as fees", () => {
        const event = mapAlpacaAccountPnlEvent(activity({
            activity_type: "FEE",
            net_amount: "-0.01",
            description: "CAT fee",
        }))

        expect(event?.eventType).toBe("fee")
        expect(event?.amount).toBe(-0.01)
    })

    it("maps settlement and journal cash motions as adjustments", () => {
        for (const activityType of ["OPCSH", "JNLC", "MISC"]) {
            const event = mapAlpacaAccountPnlEvent(activity({
                activity_type: activityType,
                net_amount: "-100",
                description: "option settlement",
            }))

            expect(event?.eventType).toBe("adjustment")
            expect(event?.amount).toBe(-100)
        }
    })
})

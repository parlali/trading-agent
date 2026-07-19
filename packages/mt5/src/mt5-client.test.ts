import { describe, expect, it } from "vitest"
import { MT5Client } from "./mt5-client.ts"

describe("MT5Client.mapOrderResultToExecution", () => {
    const client = new MT5Client()

    it("uses the fallback order id for cancel responses", () => {
        const execution = client.mapOrderResultToExecution({
            retcode: 10009,
            retcodeDescription: "Request completed",
            orderId: "",
            volume: 0,
            price: 0,
            success: true,
        }, {
            fallbackOrderId: "12345",
            successStatus: "cancelled",
            filledQuantity: 0,
        })

        expect(execution.orderId).toBe("12345")
        expect(execution.status).toBe("cancelled")
        expect(execution.fillPrice).toBeUndefined()
    })

    it("maps MT5 partial completion retcode to partially filled", () => {
        const execution = client.mapOrderResultToExecution({
            retcode: 10010,
            retcodeDescription: "Request partially completed",
            orderId: "12345",
            volume: 0.02,
            price: 4715.5,
            success: true,
        })

        expect(execution.status).toBe("partially_filled")
        expect(execution.filledQuantity).toBe(0.02)
        expect(execution.fillPrice).toBe(4715.5)
    })
})

import { describe, expect, it } from "vitest"
import { MT5Client } from "./mt5-client"

describe("MT5Client.mapOrderResultToExecution", () => {
    const client = new MT5Client({
        workerUrl: "http://localhost:8090",
    })

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
})

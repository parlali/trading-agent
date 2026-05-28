import { describe, expect, it } from "vitest"
import { MT5Client } from "./mt5-client.ts"

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

describe("MT5Client transport retry policy", () => {
    it("does not retry order submission mutations or worker-owned connect calls", async () => {
        const submitTransport = createFailingTransport()
        const submitClient = createTransportClient(submitTransport.fetch)

        await expect(submitClient.submitOrder({
            symbol: "XAUUSD",
            side: "buy",
            volume: 0.01,
            orderType: "market",
        })).rejects.toThrow("MT5 worker error")

        expect(submitTransport.calls()).toBe(1)

        const connectTransport = createFailingTransport()
        const connectClient = createTransportClient(connectTransport.fetch, 1_000)

        await expect(connectClient.connect({
            login: 1,
            password: "secret",
            server: "broker",
        })).rejects.toThrow("MT5 worker error")

        expect(connectTransport.calls()).toBe(1)
    })

    it("preserves structured worker errors on execution mutations", async () => {
        const transport = createStructuredFailingTransport()
        const client = new MT5Client({
            workerUrl: "http://localhost:8090",
            timeout: 1_000,
            fetchImpl: transport.fetch,
        })

        try {
            await client.submitOrder({
                symbol: "XAUUSD",
                side: "buy",
                volume: 0.01,
                orderType: "market",
            })
        } catch (error) {
            const executionError = (error as { executionError?: { code?: string; retryable?: boolean; details?: Record<string, unknown> } }).executionError
            expect(executionError?.code).toBe("query_failed")
            expect(executionError?.retryable).toBe(false)
            expect(executionError?.details?.workerError).toMatchObject({
                error: "positions_get failed: IPC recv failed (-10002)",
                errorType: "query_failed",
                retryable: false,
            })
            expect(transport.calls()).toBe(1)
            return
        }

        throw new Error("Expected structured worker error")
    })
})

function createTransportClient(fetchImpl: typeof fetch, connectTimeout?: number): MT5Client {
    return new MT5Client({
        workerUrl: "http://localhost:8090",
        timeout: 1_000,
        connectTimeout,
        fetchImpl,
    })
}

function createFailingTransport(): {
    fetch: typeof fetch
    calls: () => number
} {
    return createStaticErrorTransport({ error: "forced failure" }, 500, "Forced")
}

function createStructuredFailingTransport(): {
    fetch: typeof fetch
    calls: () => number
} {
    return createStaticErrorTransport({
        detail: {
            error: "positions_get failed: IPC recv failed (-10002)",
            errorType: "query_failed",
            retryable: false,
        },
    }, 503, "Service Unavailable")
}

function createStaticErrorTransport(
    body: unknown,
    status: number,
    statusText: string
): {
    fetch: typeof fetch
    calls: () => number
} {
    let calls = 0
    return {
        fetch: async () => {
            calls++
            return new Response(JSON.stringify(body), {
                status,
                statusText,
                headers: {
                    "Content-Type": "application/json",
                },
            })
        },
        calls: () => calls,
    }
}

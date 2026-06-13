import { describe, expect, it } from "vitest"
import { MT5Client, type MT5WorkerCredentials } from "./mt5-client.ts"

const credentials: MT5WorkerCredentials = {
    login: 111,
    password: "secret",
    server: "broker",
}

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

describe("MT5Client transport retry policy", () => {
    it("does not retry order submission mutations or worker-owned connect calls", async () => {
        const submitTransport = createFailingTransport()
        const submitClient = createTransportClient(submitTransport.fetch)

        await expect(submitClient.submitOrder(credentials, {
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
            await client.submitOrder(credentials, {
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

describe("MT5Client account-scoped request identity", () => {
    it("sends the expected login credentials on every account-scoped request", async () => {
        const requests: Array<{ url: string; method: string; body: Record<string, unknown> }> = []
        const fetchImpl: typeof fetch = async (input, init) => {
            requests.push({
                url: String(input),
                method: init?.method ?? "GET",
                body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
            })
            return new Response(JSON.stringify([]), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            })
        }
        const client = new MT5Client({
            workerUrl: "http://localhost:8090",
            timeout: 1_000,
            fetchImpl,
        })

        await client.getPositions(credentials)
        await client.getOpenOrders(credentials)
        await client.getPositionClosures(credentials, 12)
        await client.getAccountPnlEvents(credentials, 6)
        await client.getSymbolInfo(credentials, ["XAUUSD"])

        expect(requests.map((request) => request.url)).toEqual([
            "http://localhost:8090/positions",
            "http://localhost:8090/orders",
            "http://localhost:8090/position/closures",
            "http://localhost:8090/account/pnl-events",
            "http://localhost:8090/symbol/info",
        ])
        for (const request of requests) {
            expect(request.method).toBe("POST")
            expect(request.body).toMatchObject({
                login: credentials.login,
                password: credentials.password,
                server: credentials.server,
            })
        }
        expect(requests[2]?.body.lookbackHours).toBe(12)
        expect(requests[3]?.body.lookbackHours).toBe(6)
        expect(requests[4]?.body.symbols).toEqual(["XAUUSD"])
    })

    it("sends credentials alongside mutation payloads", async () => {
        let body: Record<string, unknown> | undefined
        const fetchImpl: typeof fetch = async (_input, init) => {
            body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
            return new Response(JSON.stringify({
                retcode: 10009,
                retcodeDescription: "Request completed",
                orderId: "1",
                volume: 0.01,
                price: 1,
                success: true,
            }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            })
        }
        const client = new MT5Client({
            workerUrl: "http://localhost:8090",
            timeout: 1_000,
            fetchImpl,
        })

        await client.closePosition(credentials, { ticket: 42, comment: "vmtc01abcde23456" })

        expect(body).toMatchObject({
            login: credentials.login,
            password: credentials.password,
            server: credentials.server,
            ticket: 42,
            comment: "vmtc01abcde23456",
        })
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

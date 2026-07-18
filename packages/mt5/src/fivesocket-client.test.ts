import { describe, expect, it } from "vitest"
import {
    fromDecimalString,
    fromUnsignedIntString,
    toDecimalString,
    toUnsignedIntString,
} from "./fivesocket-decimals.ts"
import { mapFiveSocketExecutionCommand } from "./fivesocket-mappers.ts"
import { FiveSocketClient } from "./fivesocket-client.ts"
import { MT5Client, type MT5WorkerCredentials } from "./mt5-client.ts"
import {
    createMT5TransportClient,
    resolveMT5RuntimeConfig,
} from "./runtime-config.ts"

const credentials: MT5WorkerCredentials = {
    login: 111,
    password: "secret",
    server: "broker",
}

describe("FiveSocket decimal string conversion", () => {
    it("round-trips volumes, prices, magic, and leverage as decimal/unsigned strings", () => {
        expect(toDecimalString(0.01)).toBe("0.01")
        expect(toDecimalString(4715.5)).toBe("4715.5")
        expect(toDecimalString(0)).toBe("0")
        expect(toUnsignedIntString(0)).toBe("0")
        expect(toUnsignedIntString(123456)).toBe("123456")

        expect(fromDecimalString("0.01", "volume")).toBe(0.01)
        expect(fromDecimalString("4715.5", "price")).toBe(4715.5)
        expect(fromUnsignedIntString("100", "leverage")).toBe(100)
        expect(fromUnsignedIntString("0", "magic")).toBe(0)
    })

    it("rejects invalid magic/leverage strings", () => {
        expect(() => fromUnsignedIntString("1.5", "magic")).toThrow("Invalid unsigned-int")
        expect(() => fromUnsignedIntString("-1", "leverage")).toThrow("Invalid unsigned-int")
        expect(() => toUnsignedIntString(1.5)).toThrow("non-negative integer")
    })
})

describe("FiveSocket execution outcome mapping", () => {
    const client = new MT5Client({ workerUrl: "http://localhost:8090" })

    it("maps accepted outcomes to successful MT5 order results", () => {
        const result = mapFiveSocketExecutionCommand({
            commandId: "cmd-1",
            operation: "order.submit",
            outcome: "accepted",
            status: "filled",
            retcode: 10009,
            retcodeExternal: null,
            retcodeDescription: "Request completed",
            orderId: "1588167645",
            dealId: "9001",
            clientOrderId: "vmte01abcde23456",
            volume: "0.02",
            price: "4715.5",
            recovered: false,
            observedAt: new Date().toISOString(),
            latencyMs: 12,
        })

        expect(result).toMatchObject({
            success: true,
            retcode: 10009,
            orderId: "1588167645",
            dealId: "9001",
            volume: 0.02,
            price: 4715.5,
            comment: "vmte01abcde23456",
        })
        expect(client.mapOrderResultToExecution(result).status).toBe("filled")
    })

    it("maps rejected outcomes without success", () => {
        const result = mapFiveSocketExecutionCommand({
            commandId: "cmd-2",
            operation: "order.submit",
            outcome: "rejected",
            status: "rejected",
            retcode: 10016,
            retcodeExternal: null,
            retcodeDescription: "Invalid stops",
            volume: "0.01",
            price: "0",
            recovered: false,
            observedAt: new Date().toISOString(),
            latencyMs: 8,
        })

        expect(result.success).toBe(false)
        expect(client.mapOrderResultToExecution(result).status).toBe("rejected")
    })

    it("maps unresolved outcomes to terminal manual-reconciliation results", () => {
        const result = mapFiveSocketExecutionCommand({
            commandId: "cmd-3",
            operation: "order.modify",
            outcome: "unresolved",
            status: "unknown",
            retcode: null,
            retcodeExternal: null,
            retcodeDescription: "Modify response lost",
            volume: "0",
            price: "0",
            recovered: false,
            observedAt: new Date().toISOString(),
            latencyMs: 4,
        })

        expect(result.unresolved).toBe(true)
        expect(result.success).toBe(false)

        const execution = client.mapOrderResultToExecution(result, {
            fallbackOrderId: "42",
            successStatus: "pending",
        })
        expect(execution.status).toBe("rejected")
        expect(execution.errorDetail?.code).toBe("NEEDS_MANUAL_RECONCILIATION")
        expect(execution.errorDetail?.retryable).toBe(false)
    })

    it("maps commit_unknown commands to commitUnknown results before throw path", () => {
        const result = mapFiveSocketExecutionCommand({
            commandId: "cmd-4",
            operation: "order.submit",
            outcome: "commit_unknown",
            status: "unknown",
            retcode: null,
            retcodeExternal: null,
            retcodeDescription: "Commit unknown",
            clientOrderId: "vmte01abcde23456",
            volume: "0.01",
            price: "0",
            recovered: false,
            observedAt: new Date().toISOString(),
            latencyMs: 20,
        })

        expect(result.commitUnknown).toBe(true)
        expect(result.success).toBe(false)
        expect(result.comment).toBe("vmte01abcde23456")
    })
})

describe("FiveSocketClient transport policy", () => {
    it("does not retry mutations or connect", async () => {
        const submitTransport = createCountingTransport(async (input, init) => {
            const url = String(input)
            const method = init?.method ?? "GET"
            if (method === "POST" && url.endsWith("/v1/accounts")) {
                return jsonResponse({
                    id: "acc-1",
                    login: "111",
                    server: "broker",
                    status: "active",
                    createdAt: new Date().toISOString(),
                }, 201)
            }
            return new Response(JSON.stringify({
                error: { code: "internal_error", message: "boom", requestId: "r1" },
            }), { status: 500 })
        })
        const submitClient = createClient(submitTransport.fetch)

        await expect(submitClient.submitOrder(credentials, {
            symbol: "XAUUSD",
            side: "buy",
            volume: 0.01,
            orderType: "market",
            comment: "vmte01abcde23456",
        })).rejects.toThrow("FiveSocket error")
        expect(submitTransport.calls()).toBe(2)

        const connectTransport = createCountingTransport(async () =>
            new Response(JSON.stringify({
                error: { code: "internal_error", message: "boom", requestId: "r2" },
            }), { status: 500 })
        )
        const connectClient = createClient(connectTransport.fetch)

        await expect(connectClient.connect(credentials)).rejects.toThrow("FiveSocket error")
        expect(connectTransport.calls()).toBe(1)
    })

    it("serializes mutation bodies as decimal strings and sets clientOrderId + Idempotency-Key", async () => {
        const requests: Array<{ url: string; method: string; headers: Headers; body: unknown }> = []
        const fetchImpl: typeof fetch = async (input, init) => {
            const url = String(input)
            const method = init?.method ?? "GET"
            const headers = new Headers(init?.headers)
            const body = init?.body ? JSON.parse(String(init.body)) : undefined
            requests.push({ url, method, headers, body })

            if (method === "POST" && url.endsWith("/v1/accounts")) {
                return jsonResponse({
                    id: "acc-1",
                    login: "111",
                    server: "broker",
                    status: "active",
                    createdAt: new Date().toISOString(),
                }, 201)
            }

            if (method === "PUT" && url.endsWith("/execution")) {
                return jsonResponse({
                    accountId: "acc-1",
                    status: "enabled",
                    symbols: body.symbols,
                    updatedAt: new Date().toISOString(),
                })
            }

            if (method === "POST" && url.endsWith("/execution/orders")) {
                return jsonResponse(acceptedCommand({
                    clientOrderId: body.clientOrderId,
                    volume: body.volume,
                    price: body.price ?? "0",
                }))
            }

            throw new Error(`Unexpected request ${method} ${url}`)
        }

        const client = createClient(fetchImpl, [{ symbol: "XAUUSD", maxVolume: "1.0" }])
        const result = await client.submitOrder(credentials, {
            symbol: "XAUUSD",
            side: "buy",
            volume: 0.01,
            orderType: "limit",
            price: 4715.5,
            magic: 42,
            stopLoss: 4700,
            takeProfit: 4750,
            comment: "vmte01abcde23456",
        })

        const submit = requests.find((request) =>
            request.method === "POST" && String(request.url).endsWith("/execution/orders")
        )
        expect(submit?.headers.get("Idempotency-Key")).toBe("vmte01abcde23456")
        expect(submit?.headers.get("Authorization")).toBe("Bearer test-key")
        expect(submit?.body).toMatchObject({
            clientOrderId: "vmte01abcde23456",
            symbol: "XAUUSD",
            side: "buy",
            type: "limit",
            volume: "0.01",
            price: "4715.5",
            stopLoss: "4700",
            takeProfit: "4750",
            magic: "42",
        })
        expect(result.success).toBe(true)
        expect(result.comment).toBe("vmte01abcde23456")
    })

    it("polls commit_unknown commands then throws retryable commit_unknown for adapter recovery", async () => {
        let commandPolls = 0
        const fetchImpl: typeof fetch = async (input, init) => {
            const url = String(input)
            const method = init?.method ?? "GET"
            const body = init?.body ? JSON.parse(String(init.body)) : undefined

            if (method === "POST" && url.endsWith("/v1/accounts")) {
                return jsonResponse({
                    id: "acc-1",
                    login: "111",
                    server: "broker",
                    status: "active",
                    createdAt: new Date().toISOString(),
                }, 201)
            }

            if (method === "POST" && url.endsWith("/execution/orders")) {
                return jsonResponse(commitUnknownCommand({
                    commandId: "cmd-unknown",
                    clientOrderId: body.clientOrderId,
                }), 202)
            }

            if (method === "GET" && url.includes("/execution/commands/cmd-unknown")) {
                commandPolls += 1
                return jsonResponse(commitUnknownCommand({
                    commandId: "cmd-unknown",
                    clientOrderId: "vmte01abcde23456",
                }), 202)
            }

            throw new Error(`Unexpected request ${method} ${url}`)
        }

        const client = new FiveSocketClient({
            baseUrl: "https://api.fivesocket.com",
            apiKey: "test-key",
            timeout: 1_000,
            commandPollAttempts: 2,
            commandPollDelayMs: 1,
            fetchImpl,
        })

        try {
            await client.submitOrder(credentials, {
                symbol: "XAUUSD",
                side: "buy",
                volume: 0.01,
                orderType: "market",
                comment: "vmte01abcde23456",
            })
            throw new Error("Expected commit_unknown throw")
        } catch (error) {
            const executionError = (error as { executionError?: { code?: string; retryable?: boolean } }).executionError
            expect(executionError?.code).toBe("commit_unknown")
            expect(executionError?.retryable).toBe(true)
            expect(commandPolls).toBe(2)
        }
    })

    it("returns unresolved terminal results without retrying the mutation", async () => {
        let mutateCalls = 0
        const fetchImpl: typeof fetch = async (input, init) => {
            const url = String(input)
            const method = init?.method ?? "GET"

            if (method === "POST" && url.endsWith("/v1/accounts")) {
                return jsonResponse({
                    id: "acc-1",
                    login: "111",
                    server: "broker",
                    status: "active",
                    createdAt: new Date().toISOString(),
                }, 201)
            }

            if (method === "PATCH" && url.includes("/execution/orders/")) {
                mutateCalls += 1
                return jsonResponse({
                    commandId: "cmd-unresolved",
                    operation: "order.modify",
                    outcome: "unresolved",
                    status: "unknown",
                    retcode: null,
                    retcodeExternal: null,
                    retcodeDescription: "Modify response lost",
                    volume: "0",
                    price: "0",
                    recovered: false,
                    observedAt: new Date().toISOString(),
                    latencyMs: 3,
                })
            }

            throw new Error(`Unexpected request ${method} ${url}`)
        }

        const client = createClient(fetchImpl)
        const result = await client.modifyOrder(credentials, {
            ticket: 42,
            stopLoss: 4700,
        })

        expect(mutateCalls).toBe(1)
        expect(result.unresolved).toBe(true)
        expect(result.success).toBe(false)
    })
})

describe("MT5 runtime transport selection", () => {
    it("selects FiveSocket transport from env/config", () => {
        const runtime = resolveMT5RuntimeConfig({
            MT5_TRANSPORT: "fivesocket",
            FIVESOCKET_API_KEY: "fs-key",
            MT5_PRIMARY_LOGIN: "111",
            MT5_PRIMARY_PASSWORD: "secret",
            MT5_PRIMARY_SERVER: "broker",
            MT5_WORKER_URL: null,
            MT5_WORKER_ACCESS_KEY: null,
            FIVESOCKET_API_BASE_URL: null,
        }, {})

        expect(runtime.transport).toBe("fivesocket")
        if (runtime.transport !== "fivesocket") {
            throw new Error("expected fivesocket")
        }
        expect(runtime.baseUrl).toBe("https://api.fivesocket.com")
        expect(runtime.apiKey).toBe("fs-key")

        const client = createMT5TransportClient(runtime)
        expect(client).toBeInstanceOf(FiveSocketClient)
    })

    it("keeps worker transport as the default", () => {
        const runtime = resolveMT5RuntimeConfig({
            MT5_TRANSPORT: null,
            MT5_WORKER_URL: "http://localhost:8090",
            MT5_WORKER_ACCESS_KEY: "worker-key",
            MT5_PRIMARY_LOGIN: "111",
            MT5_PRIMARY_PASSWORD: "secret",
            MT5_PRIMARY_SERVER: "broker",
            FIVESOCKET_API_KEY: null,
            FIVESOCKET_API_BASE_URL: null,
        }, {})

        expect(runtime.transport).toBe("worker")
        const client = createMT5TransportClient(runtime)
        expect(client).toBeInstanceOf(MT5Client)
        expect(client).not.toBeInstanceOf(FiveSocketClient)
    })
})

function createClient(
    fetchImpl: typeof fetch,
    executionSymbols: Array<{ symbol: string; maxVolume: string }> = []
): FiveSocketClient {
    return new FiveSocketClient({
        baseUrl: "https://api.fivesocket.com",
        apiKey: "test-key",
        timeout: 1_000,
        executionSymbols,
        fetchImpl,
    })
}

function createCountingTransport(handler: typeof fetch): {
    fetch: typeof fetch
    calls: () => number
} {
    let calls = 0
    return {
        calls: () => calls,
        fetch: async (input, init) => {
            calls += 1
            return await handler(input, init)
        },
    }
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    })
}

function acceptedCommand(params: {
    clientOrderId: string
    volume: string
    price: string
}) {
    return {
        commandId: "cmd-accepted",
        operation: "order.submit",
        outcome: "accepted",
        status: "filled",
        retcode: 10009,
        retcodeExternal: null,
        retcodeDescription: "Request completed",
        orderId: "1588167645",
        dealId: "9001",
        clientOrderId: params.clientOrderId,
        volume: params.volume,
        price: params.price,
        recovered: false,
        observedAt: new Date().toISOString(),
        latencyMs: 10,
    }
}

function commitUnknownCommand(params: {
    commandId: string
    clientOrderId: string
}) {
    return {
        commandId: params.commandId,
        operation: "order.submit",
        outcome: "commit_unknown",
        status: "unknown",
        retcode: null,
        retcodeExternal: null,
        retcodeDescription: "Commit unknown",
        clientOrderId: params.clientOrderId,
        volume: "0.01",
        price: "0",
        recovered: false,
        observedAt: new Date().toISOString(),
        latencyMs: 10,
    }
}

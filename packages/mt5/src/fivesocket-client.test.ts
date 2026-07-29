import { describe, expect, it } from "vitest"
import {
    fromDecimalString,
    fromSafeIntegerString,
    fromUnsignedIntString,
    toDecimalString,
    toPriceDecimalString,
    toUnsignedIntString,
    toVolumeDecimalString,
} from "./fivesocket-decimals.ts"
import {
    mapFiveSocketAccountPnlEvents,
    mapFiveSocketDealToClosure,
    mapFiveSocketExecutionCommand,
    mapFiveSocketExecutionSymbol,
    mapFiveSocketPosition,
    mapFiveSocketPositionClosures,
    mapFiveSocketWorkingOrder,
} from "./fivesocket-mappers.ts"
import { FiveSocketClient } from "./fivesocket-client.ts"
import { MT5Client, type MT5AccountCredentials } from "./mt5-client.ts"
import {
    createMT5Client,
    resetMT5ClientPoolForTests,
    resolveCanonicalFiveSocketAccountExecutionSymbols,
    resolveFiveSocketExecutionSymbolsForPolicies,
    resolveMT5RuntimeConfig,
} from "./runtime-config.ts"
import { mapMT5OrderState, resolveMT5FilledQuantity } from "./venue-mappers.ts"
import { getExecutionErrorDetail } from "@valiq-trading/core"

const credentials: MT5AccountCredentials = {
    login: 111,
    password: "secret",
    server: "broker",
}

describe("FiveSocket decimal string conversion", () => {
    it("round-trips volumes, prices, magic, and leverage as decimal/unsigned strings", () => {
        expect(toVolumeDecimalString(0.01)).toBe("0.01")
        expect(toPriceDecimalString(4715.5)).toBe("4715.5")
        expect(toDecimalString(0)).toBe("0")
        expect(toUnsignedIntString(0)).toBe("0")
        expect(toUnsignedIntString(123456)).toBe("123456")
        expect(toUnsignedIntString(4_294_967_295)).toBe("4294967295")

        expect(fromDecimalString("0.01", "volume")).toBe(0.01)
        expect(fromDecimalString("4715.5", "price")).toBe(4715.5)
        expect(fromUnsignedIntString("100", "leverage")).toBe(100)
        expect(fromUnsignedIntString("0", "magic")).toBe(0)
    })

    it("serializes plainly, accepts scientific-notation reads, and rejects invalid volumes", () => {
        expect(toVolumeDecimalString(0.1 + 0.2)).toBe("0.3")
        expect(toVolumeDecimalString(1e-7)).toBe("0.0000001")
        expect(() => toVolumeDecimalString(0)).toThrow("positive decimal")
        expect(() => toVolumeDecimalString(-0.01)).toThrow("positive decimal")
        expect(() => toVolumeDecimalString(1e21)).toThrow("safe plain serialization")
        expect(fromDecimalString("1e-7", "volume")).toBe(1e-7)
        expect(fromDecimalString("1e-05", "symbol.point")).toBe(0.00001)
        expect(fromDecimalString("-2.5e-3", "swap")).toBe(-0.0025)
        expect(() => fromDecimalString("1234567890123456", "volume")).toThrow("safe precision")
        expect(() => fromDecimalString("1.23456789012345e-10", "price")).not.toThrow()
        expect(() => fromDecimalString("not-a-number", "price")).toThrow("Invalid decimal")
    })

    it("rejects invalid magic/leverage strings", () => {
        expect(() => fromUnsignedIntString("1.5", "magic")).toThrow("Invalid unsigned-int")
        expect(() => fromUnsignedIntString("-1", "leverage")).toThrow("Invalid unsigned-int")
        expect(() => toUnsignedIntString(1.5)).toThrow("non-negative integer")
        expect(() => toUnsignedIntString(4_294_967_296)).toThrow("uint32 max")
        expect(() => fromUnsignedIntString("4294967296", "magic")).toThrow("Unsafe unsigned-int")
    })
})

describe("FiveSocket execution outcome mapping", () => {
    const client = new MT5Client()

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
            providerStatus: "filled",
        })
        expect(client.mapOrderResultToExecution(result).status).toBe("filled")
    })

    it("maps accepted status cases from command.status instead of outcome alone", () => {
        const placed = mapFiveSocketExecutionCommand({
            commandId: "cmd-placed",
            operation: "order.submit",
            outcome: "accepted",
            status: "placed",
            retcode: null,
            retcodeExternal: null,
            retcodeDescription: "Order placed",
            orderId: "1",
            volume: "0.01",
            price: "4715.5",
            recovered: false,
            observedAt: new Date().toISOString(),
            latencyMs: 1,
        })
        expect(placed).toMatchObject({ success: true, retcode: 10008, providerStatus: "placed" })
        expect(client.mapOrderResultToExecution(placed)).toMatchObject({
            status: "pending",
            filledQuantity: 0,
        })

        const partial = mapFiveSocketExecutionCommand({
            commandId: "cmd-partial",
            operation: "order.submit",
            outcome: "accepted",
            status: "partially_filled",
            retcode: null,
            retcodeExternal: null,
            retcodeDescription: "Partial",
            orderId: "2",
            volume: "0.6",
            price: "4715.5",
            recovered: false,
            observedAt: new Date().toISOString(),
            latencyMs: 1,
        })
        expect(partial).toMatchObject({ success: true, retcode: 10010, volume: 0.6 })
        expect(client.mapOrderResultToExecution(partial).status).toBe("partially_filled")

        const canceled = mapFiveSocketExecutionCommand({
            commandId: "cmd-canceled",
            operation: "order.cancel",
            outcome: "accepted",
            status: "canceled",
            retcode: 10009,
            retcodeExternal: null,
            retcodeDescription: "Canceled",
            orderId: "3",
            volume: "0",
            price: "0",
            recovered: false,
            observedAt: new Date().toISOString(),
            latencyMs: 1,
        })
        expect(client.mapOrderResultToExecution(canceled, {
            successStatus: "cancelled",
            filledQuantity: 0,
        }).status).toBe("cancelled")
    })

    it("does not promote rejected modifies with retcode 10025 via successRetcodes", () => {
        const result = mapFiveSocketExecutionCommand({
            commandId: "cmd-rejected-10025",
            operation: "order.modify",
            outcome: "rejected",
            status: "rejected",
            retcode: 10025,
            retcodeExternal: null,
            retcodeDescription: "Rejected despite no-changes code",
            orderId: "42",
            volume: "0",
            price: "0",
            recovered: false,
            observedAt: new Date().toISOString(),
            latencyMs: 1,
        })

        const execution = client.mapOrderResultToExecution(result, {
            successStatus: "pending",
            filledQuantity: 0,
            successRetcodes: [10025],
        })
        expect(execution.status).toBe("rejected")
        expect(result.allowSuccessRetcodePromotion).toBe(false)
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

    it("honors Retry-After on HTTP 429 before retrying a read", async () => {
        let positionAttempts = 0
        const startedAt = Date.now()
        const fetchImpl = createAccountAwareFetch(async (url, method) => {
            if (method === "GET" && url.endsWith("/positions")) {
                positionAttempts += 1
                if (positionAttempts === 1) {
                    return new Response(JSON.stringify({
                        error: {
                            code: "rate_limit_exceeded",
                            message: "slow down",
                            requestId: "rate-1",
                        },
                    }), {
                        status: 429,
                        statusText: "Too Many Requests",
                        headers: { "Content-Type": "application/json", "Retry-After": "2" },
                    })
                }
                return jsonResponse({ positions: [] })
            }
            throw new Error(`Unexpected ${method} ${url}`)
        })

        const client = new FiveSocketClient({
            baseUrl: "https://api.fivesocket.com",
            apiKey: "test-key",
            timeout: 3_000,
            minRequestIntervalMs: 0,
            fetchImpl,
        })

        await expect(client.getPositions(credentials)).resolves.toEqual([])
        expect(positionAttempts).toBe(2)
        const elapsed = Date.now() - startedAt
        expect(elapsed).toBeGreaterThanOrEqual(1_900)
        expect(elapsed).toBeLessThan(3_000)
    }, 4_000)

    it("watermarks deal reads with overlap and restarts with a full lookback", async () => {
        const newestDealMs = Date.now() - 30 * 60 * 1000
        const newestDealTime = new Date(newestDealMs).toISOString()
        const expectedOverlapFrom = new Date(newestDealMs - 15 * 60 * 1000).toISOString()
        const dealUrls: string[] = []
        const fetchImpl = createAccountAwareFetch(async (url, method) => {
            if (method === "GET" && url.includes("/deals")) {
                dealUrls.push(url)
                const deal = createDeal("1815793222", newestDealTime)
                return jsonResponse({
                    data: dealUrls.length === 2 ? [deal, deal] : [deal],
                    nextCursor: null,
                })
            }
            throw new Error(`Unexpected ${method} ${url}`)
        })

        const client = new FiveSocketClient({
            baseUrl: "https://api.fivesocket.com",
            apiKey: "test-key",
            timeout: 1_000,
            minRequestIntervalMs: 0,
            fetchImpl,
        })

        await expect(client.getPositionClosures(credentials, 24)).resolves.toHaveLength(1)
        await expect(client.getPositionClosures(credentials, 24)).resolves.toHaveLength(1)

        expect(requireQueryParam(dealUrls[1]!, "from")).toBe(expectedOverlapFrom)

        const restarted = new FiveSocketClient({
            baseUrl: "https://api.fivesocket.com",
            apiKey: "test-key",
            timeout: 1_000,
            minRequestIntervalMs: 0,
            fetchImpl,
        })
        await expect(restarted.getPositionClosures(credentials, 24)).resolves.toHaveLength(1)

        const restartFrom = Date.parse(requireQueryParam(dealUrls[2]!, "from"))
        const restartTo = Date.parse(requireQueryParam(dealUrls[2]!, "to"))
        expect(requireQueryParam(dealUrls[2]!, "from")).not.toBe(expectedOverlapFrom)
        expect(Math.abs((restartTo - restartFrom) - 24 * 60 * 60 * 1000)).toBeLessThan(1_000)
    })

    it("paces concurrent reads and lets execution mutations bypass queued reads", async () => {
        const minRequestIntervalMs = 120
        const events: Array<{ kind: string; at: number }> = []
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

            if (method === "GET" && url.endsWith("/balance")) {
                return jsonResponse({
                    accountId: "acc-1",
                    login: "111",
                    server: "broker",
                    observedAt: new Date().toISOString(),
                    latencyMs: 1,
                    balance: "1000",
                    equity: "1000",
                    currency: "USD",
                    credit: "0",
                    margin: "0",
                    marginFree: "1000",
                    profit: "0",
                    leverage: "100",
                    name: "Demo",
                    company: "Broker",
                })
            }

            if (method === "GET" && url.endsWith("/positions")) {
                events.push({ kind: "positions", at: Date.now() })
                return jsonResponse({ positions: [] })
            }

            if (method === "GET" && url.endsWith("/execution/orders")) {
                events.push({ kind: "orders", at: Date.now() })
                return jsonResponse({ data: [] })
            }

            if (method === "POST" && url.endsWith("/execution/orders")) {
                events.push({ kind: "mutation", at: Date.now() })
                return jsonResponse(acceptedCommand({
                    clientOrderId: body.clientOrderId,
                    volume: body.volume,
                    price: body.price ?? "0",
                }))
            }

            throw new Error(`Unexpected request ${method} ${url}`)
        }

        const client = new FiveSocketClient({
            baseUrl: "https://api.fivesocket.com",
            apiKey: "test-key",
            timeout: 1_000,
            minRequestIntervalMs,
            fetchImpl,
        })

        await client.connect(credentials)
        await delay(minRequestIntervalMs + 20)
        events.length = 0

        const firstRead = client.getPositions(credentials)
        const queuedRead = client.getOpenOrders(credentials)
        await delay(10)
        const mutation = client.submitOrder(credentials, {
            symbol: "XAUUSD",
            side: "buy",
            volume: 0.01,
            orderType: "market",
            comment: "vmte01abcde23456",
        })

        await Promise.all([firstRead, queuedRead, mutation])

        const readStarts = events
            .filter((event) => event.kind === "positions" || event.kind === "orders")
            .map((event) => event.at)
            .sort((left, right) => left - right)
        expect(readStarts).toHaveLength(2)
        expect(readStarts[1]! - readStarts[0]!).toBeGreaterThanOrEqual(minRequestIntervalMs - 10)

        const mutationStart = events.find((event) => event.kind === "mutation")?.at
        const queuedReadStart = events.find((event) => event.kind === "orders")?.at
        expect(mutationStart).toBeDefined()
        expect(queuedReadStart).toBeDefined()
        expect(mutationStart!).toBeLessThan(queuedReadStart!)
    })

    it("keeps the execution-policy Idempotency-Key within the 128-character API limit for multi-symbol policies", async () => {
        const requests: Array<{ url: string; method: string; headers: Headers }> = []
        const fetchImpl: typeof fetch = async (input, init) => {
            const url = String(input)
            const method = init?.method ?? "GET"
            requests.push({ url, method, headers: new Headers(init?.headers) })

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
                    symbols: [],
                    updatedAt: new Date().toISOString(),
                })
            }

            if (method === "GET" && url.includes("/balance")) {
                return jsonResponse({
                    login: "111",
                    name: "test",
                    server: "broker",
                    company: "test",
                    balance: "1000",
                    equity: "1000",
                    margin: "0",
                    marginFree: "1000",
                    marginLevel: "0",
                    currency: "USD",
                    leverage: "100",
                    profit: "0",
                    marginMode: "retail_hedging",
                    tradeAllowed: true,
                })
            }

            throw new Error(`Unexpected request ${method} ${url}`)
        }

        const symbols = ["XAUUSD", "GBPUSD", "USDJPY", "EURUSD", "USDCAD", "XAGUSD"].map((symbol) => ({
            symbol,
            maxVolume: "0.5",
        }))
        const client = createClient(fetchImpl, symbols)
        await client.connect(credentials)

        const executionPut = requests.find((request) =>
            request.method === "PUT" && request.url.endsWith("/execution")
        )
        const key = executionPut?.headers.get("Idempotency-Key")
        expect(key).toBeTruthy()
        expect((key ?? "").length).toBeLessThanOrEqual(128)
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

    it("rejects invalid clientOrderId values before any network call", async () => {
        let calls = 0
        const fetchImpl: typeof fetch = async () => {
            calls += 1
            throw new Error("network should not be reached")
        }
        const client = createClient(fetchImpl)

        await expect(client.submitOrder(credentials, {
            symbol: "XAUUSD",
            side: "buy",
            volume: 0.01,
            orderType: "market",
            comment: "bad comment with spaces",
        })).rejects.toThrow("clientOrderId")

        await expect(client.submitOrder(credentials, {
            symbol: "XAUUSD",
            side: "buy",
            volume: 0.01,
            orderType: "market",
            comment: "x".repeat(32),
        })).rejects.toThrow("clientOrderId")

        expect(calls).toBe(0)
    })

    it("uses a unique Idempotency-Key per modify attempt even for A->B->A content replay", async () => {
        const modifyKeys: string[] = []
        const fetchImpl = createAccountAwareFetch(async (url, method, body, headers) => {
            if (method === "PATCH" && url.includes("/execution/orders/42")) {
                modifyKeys.push(headers.get("Idempotency-Key") ?? "")
                return jsonResponse({
                    commandId: `cmd-${modifyKeys.length}`,
                    operation: "order.modify",
                    outcome: "accepted",
                    status: "modified",
                    retcode: 10009,
                    retcodeExternal: null,
                    retcodeDescription: "Request completed",
                    orderId: "42",
                    volume: "0",
                    price: "0",
                    stopLoss: body?.stopLoss,
                    recovered: false,
                    observedAt: new Date().toISOString(),
                    latencyMs: 2,
                })
            }
            throw new Error(`Unexpected ${method} ${url}`)
        })

        const client = createClient(fetchImpl)
        await client.modifyOrder(credentials, { ticket: 42, stopLoss: 4700 })
        await client.modifyOrder(credentials, { ticket: 42, stopLoss: 4680 })
        await client.modifyOrder(credentials, { ticket: 42, stopLoss: 4700 })

        expect(modifyKeys).toHaveLength(3)
        expect(new Set(modifyKeys).size).toBe(3)
        for (const key of modifyKeys) {
            expect(key.startsWith("modify:42:")).toBe(true)
        }
    })

    it("applies the connect timeout as a cumulative cold-start budget", async () => {
        const startedAt = Date.now()
        const fetchImpl: typeof fetch = async (input, init) => {
            const url = String(input)
            const method = init?.method ?? "GET"
            await new Promise((resolve) => setTimeout(resolve, 40))
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
                    symbols: [{ symbol: "XAUUSD", maxVolume: "1.0" }],
                    updatedAt: new Date().toISOString(),
                })
            }
            if (method === "GET" && url.endsWith("/balance")) {
                return jsonResponse({
                    accountId: "acc-1",
                    login: "111",
                    server: "broker",
                    observedAt: new Date().toISOString(),
                    latencyMs: 1,
                    balance: "1000",
                    equity: "1000",
                    currency: "USD",
                    credit: "0",
                    margin: "0",
                    marginFree: "1000",
                    profit: "0",
                    leverage: "100",
                    name: "Demo",
                    company: "Broker",
                })
            }
            throw new Error(`Unexpected ${method} ${url}`)
        }

        const client = new FiveSocketClient({
            baseUrl: "https://api.fivesocket.com",
            apiKey: "test-key",
            connectTimeout: 50,
            timeout: 1_000,
            executionSymbols: [{ symbol: "XAUUSD", maxVolume: "1.0" }],
            fetchImpl,
        })

        await expect(client.connect(credentials)).rejects.toThrow("connect budget")
        expect(Date.now() - startedAt).toBeLessThan(500)
    })

    it("bounds connect retries and backoff by the remaining connect budget", async () => {
        let accountListAttempts = 0
        const startedAt = Date.now()
        const fetchImpl: typeof fetch = async (input, init) => {
            const url = String(input)
            const method = init?.method ?? "GET"
            if (method === "POST" && url.endsWith("/v1/accounts")) {
                return jsonResponse({ error: { code: "conflict", message: "exists" } }, 409)
            }
            if (method === "GET" && url.endsWith("/v1/accounts")) {
                accountListAttempts += 1
                return jsonResponse({ error: { code: "unavailable", message: "transient" } }, 503)
            }
            throw new Error(`Unexpected ${method} ${url}`)
        }

        const client = new FiveSocketClient({
            baseUrl: "https://api.fivesocket.com",
            apiKey: "test-key",
            connectTimeout: 100,
            timeout: 30_000,
            executionSymbols: [{ symbol: "XAUUSD", maxVolume: "1.0" }],
            fetchImpl,
        })

        await expect(client.connect(credentials)).rejects.toThrow("connect budget")
        expect(accountListAttempts).toBe(1)
        expect(Date.now() - startedAt).toBeLessThan(500)
    })

    it("returns CONNECT_BUDGET_EXHAUSTED when a retryable body arrives after the connect budget", async () => {
        const fetchImpl: typeof fetch = async () => {
            return {
                status: 503,
                statusText: "Service Unavailable",
                async text() {
                    await new Promise((resolve) => setTimeout(resolve, 150))
                    return JSON.stringify({
                        error: { code: "unavailable", message: "slow body" },
                    })
                },
                async json() {
                    throw new Error("json should not be used")
                },
            } as unknown as Response
        }

        const client = new FiveSocketClient({
            baseUrl: "https://api.fivesocket.com",
            apiKey: "test-key",
            connectTimeout: 40,
            timeout: 30_000,
            executionSymbols: [{ symbol: "XAUUSD", maxVolume: "1.0" }],
            fetchImpl,
        })

        try {
            await client.connect(credentials)
            throw new Error("expected connect budget exhaustion")
        } catch (error) {
            expect(getExecutionErrorDetail(error)?.code).toBe("CONNECT_BUDGET_EXHAUSTED")
        }
    })

    it("preserves an immediate body error instead of labeling it budget exhaustion", async () => {
        const fetchImpl: typeof fetch = async (input, init) => {
            const url = String(input)
            const method = init?.method ?? "GET"
            if (method === "POST" && url.endsWith("/v1/accounts")) {
                return {
                    status: 201,
                    statusText: "Created",
                    async text() {
                        return ""
                    },
                    async json() {
                        throw new SyntaxError("Unexpected token < in JSON")
                    },
                } as unknown as Response
            }
            return jsonResponse({})
        }

        const client = new FiveSocketClient({
            baseUrl: "https://api.fivesocket.com",
            apiKey: "test-key",
            connectTimeout: 30_000,
            timeout: 30_000,
            executionSymbols: [{ symbol: "XAUUSD", maxVolume: "1.0" }],
            fetchImpl,
        })

        await expect(client.connect(credentials)).rejects.toThrow()
        await client.connect(credentials).catch((error) => {
            expect(getExecutionErrorDetail(error)?.code).not.toBe("CONNECT_BUDGET_EXHAUSTED")
        })
    })

    it("uses connect budget for cold account-link on read paths", async () => {
        let sawPositionsGet = false
        const fetchImpl: typeof fetch = async (input, init) => {
            const url = String(input)
            const method = init?.method ?? "GET"
            if (method === "POST" && url.endsWith("/v1/accounts")) {
                await new Promise((resolve) => setTimeout(resolve, 100))
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
                    symbols: [{ symbol: "XAUUSD", maxVolume: "1.0" }],
                    updatedAt: new Date().toISOString(),
                })
            }
            if (method === "GET" && url.endsWith("/positions")) {
                sawPositionsGet = true
                return jsonResponse({ positions: [] })
            }
            throw new Error(`Unexpected ${method} ${url}`)
        }

        const client = new FiveSocketClient({
            baseUrl: "https://api.fivesocket.com",
            apiKey: "test-key",
            timeout: 50,
            connectTimeout: 250,
            executionSymbols: [{ symbol: "XAUUSD", maxVolume: "1.0" }],
            fetchImpl,
        })

        await expect(client.getPositions(credentials)).resolves.toEqual([])
        expect(sawPositionsGet).toBe(true)
    })

    it("connection-test style client issues execution-policy PUT on connect", async () => {
        resetMT5ClientPoolForTests()

        const runtime = resolveMT5RuntimeConfig({
            FIVESOCKET_API_KEY: "fs-key",
            FIVESOCKET_DEFAULT_MAX_VOLUME: "1.0",
            MT5_PRIMARY_LOGIN: "111",
            MT5_PRIMARY_PASSWORD: "secret",
            MT5_PRIMARY_SERVER: "broker",
            FIVESOCKET_API_BASE_URL: null,
        }, {})

        const executionSymbols = resolveFiveSocketExecutionSymbolsForPolicies(
            [{
                llm: {
                    provider: "openrouter",
                    model: "openai/gpt-5.5",
                },
                maxRiskPercent: 1,
                minRiskReward: 1,
                tradingHours: {
                    start: "07:00",
                    end: "21:00",
                    timezone: "UTC",
                },
                safety: {
                    maxDrawdownDay: 3,
                    maxDrawdownWeek: 10,
                    cooldownMinutesAfterDayBreach: 720,
                    cooldownMinutesAfterWeekBreach: 1440,
                    strategyTimezone: "UTC",
                    sessionFlat: {
                        enabled: false,
                        closeBufferMinutes: 15,
                        timezone: "UTC",
                    },
                    account: {
                        allocationPercent: 100,
                    },
                    expectedExternalInstruments: [],
                },
                dryRun: false,
                allowMultiplePendingEntryOrdersPerInstrument: false,
                allowOverlappingExposure: false,
                marketRegionsByInstrument: {
                    XAUUSD: ["US"],
                },
            }],
            runtime.defaultMaxVolume
        )

        let putBody: unknown
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
            if (method === "PUT" && url.endsWith("/execution")) {
                putBody = init?.body ? JSON.parse(String(init.body)) : undefined
                return jsonResponse({
                    accountId: "acc-1",
                    status: "enabled",
                    symbols: executionSymbols,
                    updatedAt: new Date().toISOString(),
                })
            }
            if (method === "GET" && url.endsWith("/balance")) {
                return jsonResponse({
                    accountId: "acc-1",
                    login: "111",
                    server: "broker",
                    observedAt: new Date().toISOString(),
                    latencyMs: 1,
                    balance: "1000",
                    equity: "1000",
                    currency: "USD",
                    credit: "0",
                    margin: "0",
                    marginFree: "1000",
                    profit: "0",
                    leverage: "100",
                    name: "Demo",
                    company: "Broker",
                })
            }
            throw new Error(`Unexpected ${method} ${url}`)
        }

        const client = createMT5Client(runtime, {
            executionSymbols,
            fetchImpl,
        })
        await client.connect(credentials)
        expect(putBody).toEqual({
            symbols: [{ symbol: "XAUUSD", maxVolume: "1.0" }],
        })
    })
})

describe("FiveSocket worker-mirrored read mappings", () => {
    it("maps sell exits as long closures and reconstructs INOUT reversal volume", () => {
        const closures = mapFiveSocketPositionClosures([
            {
                id: "1",
                orderId: "10",
                positionId: "100",
                symbol: "XAUUSD",
                type: "buy",
                entry: "in",
                volume: "1.0",
                price: "4700",
                profit: "0",
                commission: "-0.5",
                swap: "0",
                fee: "0",
                magic: "0",
                time: "2026-01-01T00:00:00.000Z",
            },
            {
                id: "2",
                orderId: "11",
                positionId: "100",
                symbol: "XAUUSD",
                type: "sell",
                entry: "inout",
                volume: "1.5",
                price: "4710",
                profit: "10",
                commission: "-0.5",
                swap: "0",
                fee: "0",
                magic: "0",
                time: "2026-01-01T01:00:00.000Z",
            },
        ])

        expect(closures).toHaveLength(1)
        expect(closures[0]).toMatchObject({
            side: "long",
            volume: 1,
            positionId: 100,
        })
    })

    it("emits entry-charge pnl events for entry deal commission/fee/swap", () => {
        const events = mapFiveSocketAccountPnlEvents([
            {
                id: "9",
                orderId: "90",
                positionId: "900",
                symbol: "XAUUSD",
                type: "buy",
                entry: "in",
                volume: "0.1",
                price: "4700",
                profit: "0",
                commission: "-1.25",
                swap: "0",
                fee: "-0.25",
                magic: "0",
                time: "2026-01-01T00:00:00.000Z",
            },
        ], "USD")

        expect(events).toEqual([
            expect.objectContaining({
                providerEventId: "mt5-deal:9:entry-charges",
                eventType: "fee",
                amount: -1.5,
                currency: "USD",
            }),
        ])
    })

    it("uses point as pip size for 2/4-digit symbols", () => {
        expect(mapFiveSocketExecutionSymbol({
            symbol: "EURUSD",
            digits: 4,
            point: "0.0001",
            contractSize: "100000",
            tickSize: "0.0001",
            tickValue: "1",
            currencyBase: "EUR",
            currencyProfit: "USD",
            volumeMin: "0.01",
            volumeMax: "100",
            volumeStep: "0.01",
            bid: "1.1",
            ask: "1.1002",
            spreadPoints: 2,
            fillingMode: 1,
        }).pipSize).toBe(0.0001)

        expect(mapFiveSocketExecutionSymbol({
            symbol: "EURUSD",
            digits: 5,
            point: "0.00001",
            contractSize: "100000",
            tickSize: "0.00001",
            tickValue: "1",
            currencyBase: "EUR",
            currencyProfit: "USD",
            volumeMin: "0.01",
            volumeMax: "100",
            volumeStep: "0.01",
            bid: "1.1",
            ask: "1.10002",
            spreadPoints: 2,
            fillingMode: 1,
        }).pipSize).toBe(0.0001)
    })

    it("fails loudly when deals pagination cannot exhaust nextCursor", async () => {
        const fetchImpl = createAccountAwareFetch(async (url, method) => {
            if (method === "GET" && url.includes("/deals")) {
                return jsonResponse({
                    accountId: "acc-1",
                    login: "111",
                    server: "broker",
                    observedAt: new Date().toISOString(),
                    latencyMs: 1,
                    data: [],
                    nextCursor: "keep-going",
                })
            }
            if (method === "GET" && url.endsWith("/balance")) {
                return jsonResponse({
                    accountId: "acc-1",
                    login: "111",
                    server: "broker",
                    observedAt: new Date().toISOString(),
                    latencyMs: 1,
                    balance: "1000",
                    equity: "1000",
                    currency: "USD",
                    credit: "0",
                    margin: "0",
                    marginFree: "1000",
                    profit: "0",
                    leverage: "100",
                    name: "Demo",
                    company: "Broker",
                })
            }
            throw new Error(`Unexpected ${method} ${url}`)
        })

        const client = new FiveSocketClient({
            baseUrl: "https://api.fivesocket.com",
            apiKey: "test-key",
            timeout: 1_000,
            maxDealPages: 2,
            fetchImpl,
        })

        await expect(client.getPositionClosures(credentials, 1)).rejects.toThrow("pagination exceeded")
    })

    it("treats only HTTP 404 as order-not-found, not 500 messages mentioning 404", async () => {
        const fetchImpl = createAccountAwareFetch(async (url, method) => {
            if (method === "GET" && url.includes("/execution/orders/404")) {
                return new Response(JSON.stringify({
                    error: { code: "order_not_found", message: "missing", requestId: "r1" },
                }), { status: 404 })
            }
            if (method === "GET" && url.includes("/execution/orders/500")) {
                return new Response(JSON.stringify({
                    error: { code: "internal_error", message: "upstream 404 while reading history", requestId: "r2" },
                }), { status: 500 })
            }
            throw new Error(`Unexpected ${method} ${url}`)
        })

        const client = new FiveSocketClient({
            baseUrl: "https://api.fivesocket.com",
            apiKey: "test-key",
            timeout: 200,
            fetchImpl,
        })
        expect(await client.getOrderStatus(credentials, 404)).toBeNull()
        await expect(client.getOrderStatus(credentials, 500)).rejects.toThrow("FiveSocket error")
    }, 20_000)

    it("returns remaining volumeCurrent so the adapter can infer filled quantity", async () => {
        const fetchImpl = createAccountAwareFetch(async (url, method) => {
            if (method === "GET" && url.includes("/execution/orders/1001")) {
                return jsonResponse({
                    accountId: "acc-1",
                    login: "111",
                    server: "broker",
                    observedAt: new Date().toISOString(),
                    latencyMs: 1,
                    order: {
                        id: "1001",
                        positionId: "2001",
                        symbol: "XAUUSD",
                        type: "buy",
                        rawType: 0,
                        state: "filled",
                        rawState: 4,
                        volumeInitial: "1",
                        volumeCurrent: "0",
                        priceOpen: "4715.5",
                        setupAt: new Date().toISOString(),
                        magic: "0",
                        reason: "client",
                        rawReason: 0,
                    },
                    deals: [],
                    source: "history",
                })
            }
            if (method === "GET" && url.includes("/execution/orders/1002")) {
                return jsonResponse({
                    accountId: "acc-1",
                    login: "111",
                    server: "broker",
                    observedAt: new Date().toISOString(),
                    latencyMs: 1,
                    order: {
                        id: "1002",
                        positionId: "2002",
                        symbol: "XAUUSD",
                        type: "buy",
                        rawType: 0,
                        state: "partial",
                        rawState: 3,
                        volumeInitial: "1",
                        volumeCurrent: "0.4",
                        priceOpen: "4715.5",
                        setupAt: new Date().toISOString(),
                        magic: "0",
                        reason: "client",
                        rawReason: 0,
                    },
                    deals: [],
                    source: "working",
                })
            }
            throw new Error(`Unexpected ${method} ${url}`)
        })

        const client = createClient(fetchImpl)
        const filled = await client.getOrderStatus(credentials, 1001)
        expect(filled).toMatchObject({
            volume: 0,
            volumeInitial: 1,
            state: "filled",
        })
        expect(resolveMT5FilledQuantity(filled!, mapMT5OrderState(filled!.state))).toBe(1)

        const partial = await client.getOrderStatus(credentials, 1002)
        expect(partial).toMatchObject({
            volume: 0.4,
            volumeInitial: 1,
            state: "partial",
        })
        expect(resolveMT5FilledQuantity(partial!, mapMT5OrderState(partial!.state))).toBe(0.6)
    })
})

describe("FiveSocket round-3 hardening", () => {
    it("maps accepted+expired to a terminal expired result, not a rejection", () => {
        const result = mapFiveSocketExecutionCommand({
            commandId: "cmd-expired",
            operation: "order.submit",
            outcome: "accepted",
            status: "expired",
            retcode: null,
            retcodeExternal: null,
            retcodeDescription: "Order expired",
            orderId: "9",
            volume: "0",
            price: "0",
            recovered: false,
            observedAt: new Date().toISOString(),
            latencyMs: 1,
        })
        expect(result.success).toBe(true)
        expect(result.providerStatus).toBe("expired")
    })

    it("rejects a positive volume that would round to zero", () => {
        expect(() => toVolumeDecimalString(1e-9)).toThrow("too small")
        expect(toVolumeDecimalString(9e-9)).toBe("0.00000001")
    })

    it("fails closed on read values that exceed safe precision", () => {
        expect(() => fromSafeIntegerString("9007199254740993", "order.id")).toThrow("safe precision")
        expect(fromSafeIntegerString("9007199254740991", "order.id")).toBe(9007199254740991)
        expect(() => fromDecimalString("1.234567890123456", "price")).toThrow("safe precision")
    })

    it("rejects a whitespace-padded clientOrderId before any network call", async () => {
        const transport = createCountingTransport(async () =>
            jsonResponse({ ok: true })
        )
        const client = createClient(transport.fetch)
        await expect(client.submitOrder(credentials, {
            symbol: "XAUUSD",
            side: "buy",
            volume: 0.01,
            orderType: "market",
            comment: " vmte01abcde23456 ",
        })).rejects.toThrow("clientOrderId")
        expect(transport.calls()).toBe(0)
    })

    it("parses provider identity fields above uint32 with safe-integer bounds", () => {
        const position = mapFiveSocketPosition({
            id: "5000000000",
            identifier: "5000000001",
            symbol: "XAUUSD",
            side: "buy",
            volume: "0.01",
            openPrice: "4700",
            currentPrice: "4701",
            profit: "1",
            openedAt: "2026-01-01T00:00:00.000Z",
            swap: "0",
            magic: "42",
        })
        expect(position.ticket).toBe(5_000_000_000)
        expect(position.identifier).toBe(5_000_000_001)
        expect(position.magic).toBe(42)

        const order = mapFiveSocketWorkingOrder({
            id: "5000000000",
            positionId: "5000000002",
            symbol: "XAUUSD",
            type: "buy",
            state: "started",
            volumeInitial: "0.01",
            volumeCurrent: "0.01",
            priceOpen: "4700",
            setupAt: "2026-01-01T00:00:00.000Z",
            magic: "7",
        })
        expect(order.ticket).toBe(5_000_000_000)
        expect(order.magic).toBe(7)

        const closure = mapFiveSocketDealToClosure({
            id: "5000000000",
            orderId: "5000000003",
            positionId: "5000000004",
            symbol: "XAUUSD",
            type: "sell",
            entry: "out",
            volume: "0.01",
            price: "4701",
            profit: "1",
            commission: "0",
            swap: "0",
            fee: "0",
            magic: "9",
            time: "2026-01-01T00:00:00.000Z",
        })
        expect(closure?.ticket).toBe(5_000_000_000)
        expect(closure?.orderId).toBe(5_000_000_003)
        expect(closure?.positionId).toBe(5_000_000_004)

        expect(() => mapFiveSocketPosition({
            id: "9007199254740993",
            symbol: "XAUUSD",
            side: "buy",
            volume: "0.01",
            openPrice: "4700",
            currentPrice: "4701",
            profit: "1",
            openedAt: "2026-01-01T00:00:00.000Z",
            swap: "0",
            magic: "1",
        })).toThrow("safe precision")
        expect(() => fromUnsignedIntString("5000000000", "magic")).toThrow("Unsafe unsigned-int")
    })

    it("resolves the canonical enabled-strategy execution policy set", () => {
        const enabledGold = {
            enabled: true,
            policy: {
                llm: { provider: "openrouter", model: "openai/gpt-5.5" },
                maxRiskPercent: 1,
                minRiskReward: 1,
                tradingHours: { start: "07:00", end: "21:00", timezone: "UTC" },
                safety: {
                    maxDrawdownDay: 3,
                    maxDrawdownWeek: 10,
                    cooldownMinutesAfterDayBreach: 720,
                    cooldownMinutesAfterWeekBreach: 1440,
                    strategyTimezone: "UTC",
                    sessionFlat: { enabled: false, closeBufferMinutes: 15, timezone: "UTC" },
                    account: { allocationPercent: 100 },
                    expectedExternalInstruments: [],
                },
                dryRun: false,
                allowMultiplePendingEntryOrdersPerInstrument: false,
                allowOverlappingExposure: false,
                marketRegionsByInstrument: { XAUUSD: ["US"] },
            },
        }
        const enabledFx = {
            enabled: true,
            policy: {
                ...enabledGold.policy,
                marketRegionsByInstrument: { EURUSD: ["EU"] },
            },
        }
        const disabledExtra = {
            enabled: false,
            policy: {
                ...enabledGold.policy,
                marketRegionsByInstrument: { BTCUSD: ["US"] },
            },
        }

        expect(resolveCanonicalFiveSocketAccountExecutionSymbols(
            [enabledGold, enabledFx, disabledExtra],
            "1.0"
        )).toEqual([
            { symbol: "EURUSD", maxVolume: "1.0" },
            { symbol: "XAUUSD", maxVolume: "1.0" },
        ])

        expect(() => resolveCanonicalFiveSocketAccountExecutionSymbols(
            [{ enabled: true, policy: { broken: true } }],
            "1.0"
        )).toThrow()
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

function createAccountAwareFetch(
    handler: (url: string, method: string, body: any, headers: Headers) => Promise<Response>
): typeof fetch {
    return async (input, init) => {
        const url = String(input)
        const method = init?.method ?? "GET"
        const headers = new Headers(init?.headers)
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
        return await handler(url, method, body, headers)
    }
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

function requireQueryParam(url: string, key: string): string {
    const value = new URL(url).searchParams.get(key)
    if (!value) {
        throw new Error(`Missing query parameter ${key} in ${url}`)
    }
    return value
}

function createDeal(id: string, time: string) {
    return {
        id,
        orderId: "1815793221",
        positionId: "1815793220",
        symbol: "GBPUSD",
        type: "sell",
        entry: "out",
        volume: "0.1",
        price: "1.285",
        profit: "31.50",
        commission: "0",
        swap: "0",
        fee: "0",
        magic: "0",
        time,
    }
}

function delay(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs))
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

describe("FiveSocket session warming", () => {
    it("retries a 202 session-warming response and succeeds on the follow-up", async () => {
        let calls = 0
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
            if (method === "PUT" && url.endsWith("/execution")) {
                return jsonResponse({ accountId: "acc-1", status: "enabled", symbols: [], updatedAt: new Date().toISOString() })
            }
            if (method === "GET" && url.includes("/positions")) {
                calls += 1
                if (calls === 1) {
                    return jsonResponse({ error: { code: "session_warming", message: "The account session is warming; retry the request", retryAfter: 0 } }, 202)
                }
                return jsonResponse({ positions: [] })
            }
            throw new Error(`Unexpected ${method} ${url}`)
        }

        const client = new FiveSocketClient({
            baseUrl: "https://api.fivesocket.com",
            apiKey: "test-key",
            timeout: 5_000,
            minRequestIntervalMs: 0,
            fetchImpl,
        })
        const positions = await client.getPositions(credentials)
        expect(positions).toEqual([])
        expect(calls).toBe(2)
    })
})

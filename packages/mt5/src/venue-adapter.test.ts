import { describe, expect, it, vi } from "vitest"
import { createExecutionError, type Position } from "@valiq-trading/core"
import { MT5Client, type MT5AccountPnlEvent, type MT5OrderResult, type MT5Position, type MT5PositionClosure, type MT5SymbolInfo, type MT5WorkerCredentials } from "./mt5-client.ts"
import { MT5VenueAdapter } from "./venue-adapter.ts"

const credentials: MT5WorkerCredentials = {
    login: 123456,
    password: "test",
    server: "test-server",
}

function createClient(): MT5Client {
    const client = new MT5Client({
        workerUrl: "http://localhost:8090",
    })

    client.getHealth = async () => ({
        status: "ok",
        connected: true,
        login: credentials.login,
    })
    client.getAccount = async () => createAccountInfo()
    client.getPositions = async () => []
    client.getOpenOrders = async () => []
    client.getPositionClosures = async () => []
    client.getAccountPnlEvents = async () => []

    return client
}

function createIdentityContext(canonicalOrderId: string, role: "entry" | "close" = "entry") {
    return {
        canonicalOrderId,
        providerClientOrderId: canonicalOrderId,
        providerOrderAliases: [],
        submitAttemptId: "attempt",
        submitAttemptSequence: 1,
        commitOutcome: "accepted" as const,
        venue: "mt5",
        role,
        sequence: 1,
    }
}

describe("MT5VenueAdapter", () => {
    it("passes the bound account credentials on every account-scoped worker call", async () => {
        const client = createClient()
        const seenLogins: Array<{ method: string; login: number }> = []
        const record = (method: string, passed: MT5WorkerCredentials) => {
            seenLogins.push({ method, login: passed.login })
            expect(passed).toEqual(credentials)
        }

        client.getAccount = async (passed) => {
            record("getAccount", passed)
            return createAccountInfo()
        }
        client.getPositions = async (passed) => {
            record("getPositions", passed)
            return []
        }
        client.getOpenOrders = async (passed) => {
            record("getOpenOrders", passed)
            return []
        }
        client.getPositionClosures = async (passed) => {
            record("getPositionClosures", passed)
            return []
        }
        client.getAccountPnlEvents = async (passed) => {
            record("getAccountPnlEvents", passed)
            return []
        }
        client.submitOrder = async (passed): Promise<MT5OrderResult> => {
            record("submitOrder", passed)
            return createOrderResult({})
        }

        const adapter = new MT5VenueAdapter(client, credentials)
        await adapter.getAccountState()
        await adapter.getPositions()
        await adapter.getWorkingOrders()
        await adapter.getRecentPositionClosures()
        await adapter.getAccountPnlEvents()
        await adapter.submitOrder(createSubmissionIntent({ orderType: "market" }), {
            identity: createIdentityContext("vmte01abcde23456"),
        })

        expect(seenLogins.map((entry) => entry.method)).toEqual([
            "getAccount",
            "getPositionClosures",
            "getAccountPnlEvents",
            "getPositions",
            "getOpenOrders",
            "getPositionClosures",
            "getAccountPnlEvents",
            "submitOrder",
        ])
        expect(seenLogins.every((entry) => entry.login === credentials.login)).toBe(true)
    })

    it("fails closed when the worker serves account data for a different login", async () => {
        const client = createClient()
        client.getAccount = async () => ({
            ...createAccountInfo(),
            login: 999999,
        })

        const adapter = new MT5VenueAdapter(client, credentials)

        await expect(adapter.getAccountState()).rejects.toThrow("bound to login 123456")
        await expect(adapter.ensureConnected()).rejects.toThrow("bound to login 123456")
    })

    it("fails closed when the MT5 account currency is not USD", async () => {
        const client = createClient()
        client.getAccount = async () => ({
            ...createAccountInfo(),
            currency: "EUR",
        })

        const adapter = new MT5VenueAdapter(client, credentials)

        await expect(adapter.getAccountState()).rejects.toThrow("MT5 account currency EUR is unsupported")
    })

    it("surfaces worker session mismatch rejections instead of serving another account", async () => {
        const client = createClient()
        client.getPositions = async () => {
            throw createExecutionError(
                "venue",
                "MT5 worker error: 503 Service Unavailable MT5 active session login 222222 does not match requested login 123456",
                {
                    code: "session_login_mismatch",
                    retryable: false,
                }
            )
        }

        const adapter = new MT5VenueAdapter(client, credentials)

        await expect(adapter.getPositions()).rejects.toThrow("session login 222222")
    })

    it("retries recoverable read failures once without trusting any cached session", async () => {
        const client = createClient()
        let accountCalls = 0
        client.getAccount = async () => {
            accountCalls++
            if (accountCalls === 1) {
                throw createExecutionError("venue", "MT5 worker error: 503 Service Unavailable MT5 not connected", {
                    code: "not_connected",
                    retryable: true,
                })
            }
            return createAccountInfo()
        }

        const adapter = new MT5VenueAdapter(client, credentials)
        const state = await adapter.getAccountState()

        expect(state.equity).toBe(1000)
        expect(accountCalls).toBe(2)
    })

    it("derives MT5 day PnL from open PnL, provider closures, and account PnL events", async () => {
        const client = createClient()
        client.getAccount = async () => ({
            ...createAccountInfo(),
            profit: 4.5,
        })
        client.getPositionClosures = async (): Promise<MT5PositionClosure[]> => [{
            ticket: 5101,
            orderId: 6101,
            positionId: 4101,
            symbol: "XAUUSD",
            side: "long",
            volume: 0.01,
            price: 4719,
            profit: 7,
            swap: -0.25,
            commission: -0.5,
            fee: -0.1,
            timeDone: Date.now(),
            entry: 1,
            reason: 0,
        }]
        client.getAccountPnlEvents = async (): Promise<MT5AccountPnlEvent[]> => [{
            providerEventId: "mt5-deal:7101:entry-charges",
            eventType: "fee",
            instrument: "XAUUSD",
            amount: -0.2,
            currency: "USD",
            occurredAt: Date.now(),
            metadata: {},
        }]

        const adapter = new MT5VenueAdapter(client, credentials)
        const state = await adapter.getAccountState()

        expect(state.openPnl).toBe(4.5)
        expect(state.dayPnl).toBeCloseTo(10.45)
    })

    it("keeps successful limit submissions pending until provider status confirms a fill", async () => {
        const client = createClient()
        let submittedComment = ""
        client.submitOrder = async (_credentials, params): Promise<MT5OrderResult> => {
            submittedComment = params.comment ?? ""
            return createOrderResult({
                retcode: 10008,
                retcodeDescription: "Order placed",
                orderId: "1588167645",
            })
        }

        const adapter = new MT5VenueAdapter(client, credentials)
        const result = await adapter.submitOrder(createSubmissionIntent({
            orderType: "limit",
            limitPrice: 4715.5,
        }), {
            identity: createIdentityContext("vmte01abcde23456"),
        })

        expect(submittedComment).toBe("vmte01abcde23456")
        expect(result.orderId).toBe("1588167645")
        expect(result.providerClientOrderId).toBe("vmte01abcde23456")
        expect(result.status).toBe("pending")
        expect(result.filledQuantity).toBe(0)
        expect(result.fillPrice).toBeUndefined()
    })

    it("keeps MT5 partial completion non-terminal on submission results", async () => {
        const client = createClient()
        client.submitOrder = async (): Promise<MT5OrderResult> => createOrderResult({
            retcode: 10010,
            retcodeDescription: "Request partially completed",
            orderId: "1588167645",
            volume: 0.02,
            price: 4715.5,
        })

        const adapter = new MT5VenueAdapter(client, credentials)
        const result = await adapter.submitOrder(createSubmissionIntent({
            orderType: "limit",
            limitPrice: 4715.5,
        }), {
            identity: createIdentityContext("vmte01abcde23456"),
        })

        expect(result.status).toBe("partially_filled")
        expect(result.filledQuantity).toBe(0.02)
        expect(result.fillPrice).toBe(4715.5)
    })

    it("treats a closed submit socket as commit-unknown", () => {
        const adapter = new MT5VenueAdapter(createClient(), credentials)
        const outcome = adapter.classifySubmitError(
            new Error("The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()")
        )

        expect(outcome).toBe("commit_unknown")
    })

    it("recovers one MT5 commit-unknown order by canonical comment", async () => {
        const client = createClient()
        client.getOpenOrders = async () => [{
            ticket: 1607001000,
            symbol: "XAUUSD",
            type: "buy_limit",
            volumeInitial: 0.01,
            volumeCurrent: 0.01,
            priceOpen: 4715.5,
            stopLoss: 0,
            takeProfit: 0,
            state: "placed",
            comment: "vmte01abcde23456",
            magic: 0,
            timeSetup: Date.now(),
            timeDone: 0,
        }]

        const adapter = new MT5VenueAdapter(client, credentials)
        const recovery = await adapter.recoverSubmittedOrder(
            createSubmissionIntent({
                orderType: "limit",
                limitPrice: 4715.5,
            }),
            {
                identity: createIdentityContext("vmte01abcde23456"),
            },
            new Error("IPC recv failed")
        )

        expect(recovery).toMatchObject({
            outcome: "accepted",
            result: {
                providerOrderId: "1607001000",
                providerClientOrderId: "vmte01abcde23456",
                status: "pending",
                commitOutcome: "recovered",
            },
        })
    })

    it("recovers one MT5 commit-unknown market fill from a live position canonical comment", async () => {
        const client = createClient()
        client.getOpenOrders = async () => []
        client.getPositions = async () => [{
            ...createPosition(1607002000, "XAUUSD", 4715.75),
            comment: "vmte01filled1234",
        }]

        const adapter = new MT5VenueAdapter(client, credentials)
        const recovery = await adapter.recoverSubmittedOrder(
            createSubmissionIntent({
                orderType: "market",
            }),
            {
                identity: createIdentityContext("vmte01filled1234"),
            },
            new Error("IPC recv failed")
        )

        expect(recovery).toMatchObject({
            outcome: "accepted",
            result: {
                providerOrderId: "1607002000",
                providerClientOrderId: "vmte01filled1234",
                status: "filled",
                filledQuantity: 0.01,
                fillPrice: 4715.75,
                commitOutcome: "recovered",
            },
        })
    })

    it("reports every duplicate ticket when MT5 commit-unknown recovery is ambiguous", async () => {
        const client = createClient()
        const tickets = [1607001000, 1607001001, 1607001002, 1607001003, 1607001004]
        client.getOpenOrders = async () => tickets.map((ticket) => ({
            ticket,
            symbol: "XAUUSD",
            type: "buy_limit",
            volumeInitial: 0.01,
            volumeCurrent: 0.01,
            priceOpen: 4715.5,
            stopLoss: 0,
            takeProfit: 0,
            state: "placed",
            comment: "vmte01abcde23456",
            magic: 0,
            timeSetup: Date.now(),
            timeDone: 0,
        }))

        const adapter = new MT5VenueAdapter(client, credentials)
        const recovery = await adapter.recoverSubmittedOrder(
            createSubmissionIntent({
                orderType: "limit",
                limitPrice: 4715.5,
            }),
            {
                identity: createIdentityContext("vmte01abcde23456"),
            },
            new Error("IPC recv failed")
        )

        expect(recovery).toMatchObject({
            outcome: "ambiguous",
            details: {
                providerClientOrderId: "vmte01abcde23456",
                tickets,
            },
        })
        expect(recovery.outcome === "ambiguous" ? recovery.matches?.map((match) => match.providerOrderId) : []).toEqual(
            tickets.map(String)
        )
    })

    it("cancels every MT5 provider ticket alias and reports residual failures", async () => {
        const client = createClient()
        const cancelledTickets: number[] = []
        client.cancelOrder = async (_credentials, { ticket }): Promise<MT5OrderResult> => {
            cancelledTickets.push(ticket)
            if (ticket === 1607001002) {
                return createOrderResult({
                    retcode: 10013,
                    retcodeDescription: "Invalid request",
                    orderId: String(ticket),
                    success: false,
                })
            }

            return createOrderResult({
                retcode: 10009,
                retcodeDescription: "Request completed",
                orderId: String(ticket),
                success: true,
            })
        }
        client.getOrderStatus = async () => null

        const adapter = new MT5VenueAdapter(client, credentials)
        const result = await adapter.cancelOrder("1607001000", {
            providerOrderAliases: ["1607001001", "1607001002"],
        })

        expect(cancelledTickets).toEqual([1607001000, 1607001001, 1607001002])
        expect(result.status).toBe("rejected")
        expect(result.errorDetail).toMatchObject({
            code: "MT5_CANONICAL_CANCEL_RESIDUAL_TICKETS",
            details: {
                failedTickets: ["1607001002"],
                cancelledTickets: ["1607001000", "1607001001"],
                failedResults: [
                    expect.objectContaining({
                        providerOrderId: "1607001002",
                        status: "rejected",
                    }),
                ],
            },
        })
    })

    it("reconciles a failed MT5 cancel with current terminal provider status", async () => {
        const client = createClient()
        const cancelledTickets: number[] = []
        client.cancelOrder = async (_credentials, { ticket }): Promise<MT5OrderResult> => {
            cancelledTickets.push(ticket)
            return createOrderResult({
                retcode: 10013,
                retcodeDescription: "Invalid request",
                orderId: String(ticket),
                success: false,
            })
        }
        client.getOrderStatus = async () => ({
            ticket: 1607001002,
            symbol: "XAUUSD",
            type: "buy_limit",
            volume: 0,
            volumeInitial: 0.01,
            price: 4715.5,
            state: "filled",
        })

        const adapter = new MT5VenueAdapter(client, credentials)
        const result = await adapter.cancelOrder("1607001002")

        expect(cancelledTickets).toEqual([1607001002])
        expect(result.status).toBe("filled")
        expect(result.filledQuantity).toBe(0.01)
        expect(result.fillPrice).toBe(4715.5)
        expect(result.errorDetail).toBeUndefined()
    })

    it("cancels one parseable MT5 alias when the canonical id is not a ticket", async () => {
        const client = createClient()
        const cancelledTickets: number[] = []
        client.cancelOrder = async (_credentials, { ticket }): Promise<MT5OrderResult> => {
            cancelledTickets.push(ticket)
            return createOrderResult({
                retcode: 10009,
                retcodeDescription: "Request completed",
                orderId: String(ticket),
                success: true,
            })
        }

        const adapter = new MT5VenueAdapter(client, credentials)
        const result = await adapter.cancelOrder("vmtx01abcde23456", {
            canonicalOrderId: "vmtx01abcde23456",
            providerOrderAliases: ["1607001001"],
        })

        expect(cancelledTickets).toEqual([1607001001])
        expect(result.status).toBe("cancelled")
        expect(result.providerOrderId).toBe("1607001001")
    })

    it("dedupes MT5 aliases across canonical, provider id, and aliases", async () => {
        const client = createClient()
        const cancelledTickets: number[] = []
        client.cancelOrder = async (_credentials, { ticket }): Promise<MT5OrderResult> => {
            cancelledTickets.push(ticket)
            return createOrderResult({
                retcode: 10009,
                retcodeDescription: "Request completed",
                orderId: String(ticket),
                success: true,
            })
        }

        const adapter = new MT5VenueAdapter(client, credentials)
        await adapter.cancelOrder("vmtx01abcde23456", {
            providerOrderId: "1607001001",
            providerOrderAliases: ["1607001001", "1607001002"],
        })

        expect(cancelledTickets).toEqual([1607001001, 1607001002])
    })

    it("keeps market submissions filled on successful MT5 execution", async () => {
        const client = createClient()
        client.submitOrder = async (): Promise<MT5OrderResult> => createOrderResult({
            orderId: "1588140268",
            dealId: "1588140268",
        })

        const adapter = new MT5VenueAdapter(client, credentials)
        const result = await adapter.submitOrder(createSubmissionIntent({
            orderType: "market",
        }), {
            identity: createIdentityContext("vmte01filled1234"),
        })

        expect(result.orderId).toBe("1588140268")
        expect(result.providerClientOrderId).toBe("vmte01filled1234")
        expect(result.status).toBe("filled")
        expect(result.filledQuantity).toBe(0.01)
        expect(result.fillPrice).toBe(4715.5)
    })

    it("ignores zero stop prices during MT5 market submission and verification", async () => {
        const client = createClient()
        let submittedPrice: number | undefined
        client.submitOrder = async (_credentials, params): Promise<MT5OrderResult> => {
            submittedPrice = params.price
            return createOrderResult({
                orderId: "1588140268",
                dealId: "1588140268",
            })
        }

        const adapter = new MT5VenueAdapter(client, credentials)
        const result = await adapter.submitOrder(createSubmissionIntent({
            orderType: "market",
            stopPrice: 0,
        }), {
            identity: createIdentityContext("vmte01filled1234"),
        })

        expect(submittedPrice).toBeUndefined()
        expect(result.status).toBe("filled")

        client.getSymbolInfo = async () => [createSymbolInfo({
            bid: 4715.25,
            ask: 4715.5,
        })]

        const verification = await adapter.verify({
            instrument: "XAUUSD",
            side: "sell",
            quantity: 0.01,
            orderType: "market",
            stopPrice: 0,
            timeInForce: "gtc",
        })

        expect(verification.proposedPrice).toBe(4715.25)
        expect(verification.driftPercent).toBe(0)
    })

    it("modifies MT5 pending order price and protection through the order modify endpoint", async () => {
        const client = createClient()
        let modifyParams: Parameters<MT5Client["modifyOrder"]>[1] | undefined
        client.modifyOrder = async (_credentials, params): Promise<MT5OrderResult> => {
            modifyParams = params
            return createOrderResult({
                orderId: "1607001002",
                volume: 0,
            })
        }

        const adapter = new MT5VenueAdapter(client, credentials)
        const result = await adapter.modifyOrder("1607001002", {
            limitPrice: 4716,
            metadata: {
                stopLoss: 4705,
                takeProfit: 4730,
            },
        })

        expect(modifyParams).toEqual({
            ticket: 1607001002,
            price: 4716,
            stopLoss: 4705,
            takeProfit: 4730,
        })
        expect(result.status).toBe("pending")
        expect(result.errorDetail).toBeUndefined()
    })

    it("treats MT5 no-change modify responses as accepted no-ops", async () => {
        const client = createClient()
        client.modifyOrder = async (): Promise<MT5OrderResult> => createOrderResult({
            retcode: 10025,
            retcodeDescription: "No changes",
            orderId: "1607001002",
            volume: 0,
            price: 0,
            success: false,
        })

        const adapter = new MT5VenueAdapter(client, credentials)
        const result = await adapter.modifyOrder("1607001002", {
            metadata: {
                stopLoss: 4705,
            },
        })

        expect(result.status).toBe("pending")
        expect(result.errorDetail).toBeUndefined()
    })

    it("does not treat open MT5 order volume as filled quantity", async () => {
        const client = createClient()
        client.getOrderStatus = async () => ({
            ticket: 1588167645,
            symbol: "XAUUSD",
            type: "buy_limit",
            volume: 0.01,
            volumeInitial: 0.01,
            price: 4715.5,
            state: "placed",
        })

        const adapter = new MT5VenueAdapter(client, credentials)
        const result = await adapter.getOrderStatus("1588167645")

        expect(result.status).toBe("pending")
        expect(result.filledQuantity).toBe(0)
        expect(result.fillPrice).toBeUndefined()
    })

    it("fails closed when MT5 reports filled status with zero executable volume", async () => {
        const client = createClient()
        client.getOrderStatus = async () => ({
            ticket: 1593774587,
            symbol: "XAUUSD",
            type: "sell_limit",
            volume: 0,
            price: 0,
            state: "filled",
        })

        const adapter = new MT5VenueAdapter(client, credentials)
        const result = await adapter.getOrderStatus("1593774587")

        expect(result.status).toBe("pending")
        expect(result.filledQuantity).toBe(0)
        expect(result.fillPrice).toBeUndefined()
    })

    it("uses MT5 initial-minus-remaining volume for filled status", async () => {
        const client = createClient()
        client.getOrderStatus = async () => ({
            ticket: 1594203775,
            symbol: "XAUUSD",
            type: "sell_limit",
            volume: 0,
            volumeInitial: 0.01,
            price: 4798.66,
            state: "filled",
        })

        const adapter = new MT5VenueAdapter(client, credentials)
        const result = await adapter.getOrderStatus("1594203775")

        expect(result.status).toBe("filled")
        expect(result.filledQuantity).toBe(0.01)
        expect(result.fillPrice).toBe(4798.66)
    })

    it("attaches MT5 deal accounting metadata from filled order-status polling", async () => {
        const client = createClient()
        client.getOrderStatus = async () => ({
            ticket: 1594203775,
            symbol: "XAUUSD",
            type: "sell_limit",
            volume: 0,
            volumeInitial: 0.02,
            price: 4798.66,
            profit: 8.73,
            commission: -0.12,
            swap: 0.47,
            fee: -0.05,
            state: "filled",
        })

        const adapter = new MT5VenueAdapter(client, credentials)
        const result = await adapter.getOrderStatus("1594203775")

        expect(result.intentUpdates?.metadata).toMatchObject({
            providerAccountingSource: "mt5_deal_status",
            providerOrderId: "1594203775",
            fillPnl: 8.73,
            commission: -0.12,
            swap: 0.47,
            fee: -0.05,
        })
    })

    it("marks MT5 filled order-status polling as missing accounting when no deal accounting is present", async () => {
        const client = createClient()
        client.getOrderStatus = async () => ({
            ticket: 1594203775,
            symbol: "XAUUSD",
            type: "sell_limit",
            volume: 0,
            volumeInitial: 0.02,
            price: 4798.66,
            state: "filled",
        })

        const adapter = new MT5VenueAdapter(client, credentials)
        const result = await adapter.getOrderStatus("1594203775")

        expect(result.intentUpdates?.metadata).toMatchObject({
            providerAccountingSource: "mt5_deal_status",
            providerOrderId: "1594203775",
            providerAccountingMissing: true,
            providerAccountingMissingReason: "mt5_order_status_without_deal_accounting",
        })
    })

    it("closes only the MT5 provider ticket carried by the prepared close intent", async () => {
        const client = createClient()
        const closedTickets: number[] = []
        const closeComments: string[] = []
        let activeCloses = 0
        let maxActiveCloses = 0
        client.getPositions = async () => [
            createPosition(1588140268, "XAUUSD", 4715.5),
            createPosition(1588167645, "XAUUSD", 4715.47),
            createPosition(1589000000, "US30.cash", 39000),
        ]
        client.closePosition = async (_credentials, { ticket, comment }): Promise<MT5OrderResult> => {
            activeCloses++
            maxActiveCloses = Math.max(maxActiveCloses, activeCloses)

            try {
                await new Promise((resolve) => setTimeout(resolve, 0))
                closedTickets.push(ticket)
                closeComments.push(comment ?? "")

                return {
                    retcode: 10009,
                    retcodeDescription: "Request completed",
                    orderId: String(ticket),
                    dealId: String(ticket),
                    volume: 0.01,
                    price: ticket === 1588140268 ? 4719 : 4718.5,
                    success: true,
                }
            } finally {
                activeCloses--
            }
        }

        const adapter = new MT5VenueAdapter(client, credentials)
        const result = await adapter.closePosition("XAUUSD", {
            instrument: "XAUUSD",
            side: "sell",
            quantity: 0.01,
            orderType: "market",
            timeInForce: "ioc",
            metadata: {
                action: "close",
                ticket: 1588140268,
            },
        }, {
            identity: createIdentityContext("vmtc01abcde23456", "close"),
        })

        expect(closedTickets).toEqual([1588140268])
        expect(closeComments).toEqual(["vmtc01abcde23456"])
        expect(maxActiveCloses).toBe(1)
        expect(result.orderId).toBe("1588140268")
        expect(result.providerClientOrderId).toBe("vmtc01abcde23456")
        expect(result.status).toBe("filled")
        expect(result.filledQuantity).toBe(0.01)
        expect(result.fillPrice).toBe(4719)
    })

    it("fails closed before MT5 close mutation without canonical identity", async () => {
        const client = createClient()
        client.getPositions = vi.fn(async () => [])
        client.closePosition = vi.fn(async () => createOrderResult({}))

        const adapter = new MT5VenueAdapter(client, credentials)

        await expect(adapter.closePosition("XAUUSD")).rejects.toThrow("MT5 close requires canonical execution identity")

        expect(client.getPositions).not.toHaveBeenCalled()
        expect(client.closePosition).not.toHaveBeenCalled()
    })

    it("fails closed before broad MT5 close without provider position identity", async () => {
        const client = createClient()
        client.getPositions = vi.fn(async () => [createPosition(1588140268, "XAUUSD", 4715.5)])
        client.closePosition = vi.fn(async () => createOrderResult({}))

        const adapter = new MT5VenueAdapter(client, credentials)
        const result = await adapter.closePosition("XAUUSD", undefined, {
            identity: createIdentityContext("vmtc01abcde23456", "close"),
        })

        expect(result.status).toBe("rejected")
        expect(result.errorDetail?.code).toBe("MISSING_PROVIDER_POSITION_ID")
        expect(client.getPositions).not.toHaveBeenCalled()
        expect(client.closePosition).not.toHaveBeenCalled()
    })

    it("passes canonical close identity when closing a provider position by ticket", async () => {
        const client = createClient()
        let closeComment = ""
        client.closePosition = async (_credentials, { comment }): Promise<MT5OrderResult> => {
            closeComment = comment ?? ""
            return createOrderResult({
                orderId: "1607003001",
                dealId: "1607003001",
                price: 4719,
            })
        }

        const adapter = new MT5VenueAdapter(client, credentials)
        const result = await adapter.closeProviderPosition({
            instrument: "XAUUSD",
            providerPositionId: "1607003000",
            side: "long",
            quantity: 0.01,
            entryPrice: 4715.5,
            metadata: {
                ticket: 1607003000,
            },
        } satisfies Position, undefined, {
            identity: createIdentityContext("vmtc01abcde23457", "close"),
        })

        expect(closeComment).toBe("vmtc01abcde23457")
        expect(result.providerClientOrderId).toBe("vmtc01abcde23457")
        expect(result.status).toBe("filled")
    })

    it("maps MT5 broker-side position closures into canonical provider close records", async () => {
        const client = createClient()
        client.getPositionClosures = async (): Promise<MT5PositionClosure[]> => [{
            ticket: 1607001001,
            orderId: 1607001000,
            positionId: 1606516021,
            symbol: "US30",
            side: "long",
            volume: 1,
            price: 38952.4,
            profit: -47.6,
            swap: 0.47,
            commission: -0.12,
            timeDone: 1_714_240_000_000,
            entry: 1,
            reason: 4,
        }]

        const adapter = new MT5VenueAdapter(client, credentials)
        const closures = await adapter.getRecentPositionClosures()

        expect(closures).toEqual([{
            instrument: "US30",
            providerPositionId: "1606516021",
            side: "long",
            quantity: 1,
            fillPrice: 38952.4,
            closedAt: 1_714_240_000_000,
            metadata: {
                ticket: 1607001001,
                orderId: 1607001000,
                positionId: 1606516021,
                fillPnl: -47.6,
                profit: -47.6,
                swap: 0.47,
                commission: -0.12,
                entry: 1,
                reason: 4,
                providerAccountingSource: "mt5_deal",
            },
        }])
    })

    it("ingests MT5 entry charges and balance deals as account PnL events", async () => {
        const client = createClient()
        client.getAccountPnlEvents = async (): Promise<MT5AccountPnlEvent[]> => [
            {
                providerEventId: "mt5-deal:1607001002:entry-charges",
                eventType: "fee",
                instrument: "US30",
                amount: -0.42,
                currency: "USD",
                occurredAt: 1_714_240_001_000,
                metadata: {
                    source: "mt5_history_deals",
                    dealTicket: 1607001002,
                    commission: -0.12,
                    fee: -0.3,
                    swap: 0,
                },
            },
            {
                providerEventId: "mt5-deal:1607001003:balance",
                eventType: "adjustment",
                amount: 5,
                currency: "USD",
                occurredAt: 1_714_240_002_000,
                metadata: {
                    source: "mt5_history_deals",
                    dealTicket: 1607001003,
                },
            },
        ]

        const adapter = new MT5VenueAdapter(client, credentials)
        await expect(adapter.getAccountPnlEvents()).resolves.toEqual([
            {
                providerEventId: "mt5-deal:1607001002:entry-charges",
                eventType: "fee",
                instrument: "US30",
                amount: -0.42,
                currency: "USD",
                occurredAt: 1_714_240_001_000,
                metadata: {
                    source: "mt5_history_deals",
                    dealTicket: 1607001002,
                    commission: -0.12,
                    fee: -0.3,
                    swap: 0,
                },
            },
            {
                providerEventId: "mt5-deal:1607001003:balance",
                eventType: "adjustment",
                amount: 5,
                currency: "USD",
                occurredAt: 1_714_240_002_000,
                metadata: {
                    source: "mt5_history_deals",
                    dealTicket: 1607001003,
                },
            },
        ])
    })

    it("fails closed when MT5 account PnL events are not USD-denominated", async () => {
        const client = createClient()
        client.getAccountPnlEvents = async (): Promise<MT5AccountPnlEvent[]> => [{
            providerEventId: "mt5-deal:1607001003:balance",
            eventType: "adjustment",
            amount: 5,
            currency: "EUR",
            occurredAt: 1_714_240_002_000,
        }]

        const adapter = new MT5VenueAdapter(client, credentials)

        await expect(adapter.getAccountPnlEvents()).rejects.toThrow("MT5 account currency EUR is unsupported")
    })

    it("clamps impossible future MT5 position and working-order timestamps to the observation time", async () => {
        const now = Date.UTC(2026, 3, 23, 15, 12, 24, 623)
        const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now)

        try {
            const client = createClient()
            client.getPositions = async () => [{
                ...createPosition(1608922735, "XAUUSD", 4735.53),
                currentPrice: 4731.28,
                profit: 4.25,
                openTime: Date.UTC(2026, 3, 23, 17, 27, 20),
            }]
            client.getOpenOrders = async () => [{
                ticket: 1608821205,
                symbol: "XAUUSD",
                type: "sell_limit",
                volumeInitial: 0.01,
                volumeCurrent: 0.01,
                priceOpen: 4748,
                stopLoss: 4756.5,
                takeProfit: 4729.3,
                state: "placed",
                comment: "",
                magic: 0,
                timeSetup: Date.UTC(2026, 3, 23, 16, 42, 16),
                timeDone: Date.UTC(2026, 3, 23, 16, 42, 16),
            }]

            const adapter = new MT5VenueAdapter(client, credentials)
            const [positions, orders] = await Promise.all([
                adapter.getPositions(),
                adapter.getWorkingOrders(),
            ])

            expect(positions[0]?.metadata?.openTime).toBe(now)
            expect(orders[0]?.submittedAt).toBe(now)
            expect(orders[0]?.updatedAt).toBe(now)
        } finally {
            nowSpy.mockRestore()
        }
    })
})

function createPosition(ticket: number, symbol: string, openPrice: number): MT5Position {
    return {
        ticket,
        symbol,
        type: "buy",
        volume: 0.01,
        openPrice,
        currentPrice: openPrice,
        stopLoss: 0,
        takeProfit: 0,
        profit: 0,
        swap: 0,
        commission: 0,
        magic: 0,
        comment: "",
        openTime: 0,
        identifier: ticket,
    }
}

async function waitForExpectation(assertion: () => void): Promise<void> {
    const startedAt = Date.now()
    let lastError: unknown

    while (Date.now() - startedAt < 1000) {
        try {
            assertion()
            return
        } catch (error) {
            lastError = error
            await new Promise((resolve) => setTimeout(resolve, 10))
        }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

function createOrderResult(overrides: Partial<MT5OrderResult>): MT5OrderResult {
    return {
        retcode: 10009,
        retcodeDescription: "Request completed",
        orderId: "1588140268",
        volume: 0.01,
        price: 4715.5,
        success: true,
        ...overrides,
    }
}

function createAccountInfo() {
    return {
        login: credentials.login,
        name: "Test Account",
        server: credentials.server,
        company: "Test Broker",
        balance: 1000,
        equity: 1000,
        margin: 0,
        freeMargin: 1000,
        marginLevel: 0,
        currency: "USD",
        leverage: 500,
        profit: 0,
    }
}

function createSubmissionIntent(overrides: {
    orderType: "market" | "limit"
    limitPrice?: number
    stopPrice?: number
}) {
    return {
        instrument: "XAUUSD",
        side: "buy" as const,
        quantity: 0.01,
        timeInForce: "gtc" as const,
        ...overrides,
    }
}

function createSymbolInfo(overrides: Partial<MT5SymbolInfo>): MT5SymbolInfo {
    return {
        symbol: "XAUUSD",
        digits: 2,
        point: 0.01,
        pipSize: 0.01,
        tickValue: 1,
        contractSize: 100,
        currency: "USD",
        description: "Gold",
        spread: 25,
        volumeMin: 0.01,
        volumeMax: 100,
        volumeStep: 0.01,
        fillingMode: 2,
        bid: 4715.25,
        ask: 4715.5,
        ...overrides,
    }
}

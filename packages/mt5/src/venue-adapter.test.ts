import { describe, expect, it } from "vitest"
import { MT5Client, type MT5OrderResult, type MT5Position, type MT5PositionClosure, type MT5WorkerCredentials } from "./mt5-client.ts"
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

    return client
}

describe("MT5VenueAdapter", () => {
    it("keeps successful limit submissions pending until provider status confirms a fill", async () => {
        const client = createClient()
        client.submitOrder = async (): Promise<MT5OrderResult> => ({
            retcode: 10008,
            retcodeDescription: "Order placed",
            orderId: "1588167645",
            volume: 0.01,
            price: 4715.5,
            success: true,
        })

        const adapter = new MT5VenueAdapter(client, credentials)
        const result = await adapter.submitOrder({
            instrument: "XAUUSD",
            side: "buy",
            quantity: 0.01,
            orderType: "limit",
            limitPrice: 4715.5,
            timeInForce: "gtc",
        })

        expect(result.orderId).toBe("1588167645")
        expect(result.status).toBe("pending")
        expect(result.filledQuantity).toBe(0)
        expect(result.fillPrice).toBeUndefined()
    })

    it("keeps market submissions filled on successful MT5 execution", async () => {
        const client = createClient()
        client.submitOrder = async (): Promise<MT5OrderResult> => ({
            retcode: 10009,
            retcodeDescription: "Request completed",
            orderId: "1588140268",
            dealId: "1588140268",
            volume: 0.01,
            price: 4715.5,
            success: true,
        })

        const adapter = new MT5VenueAdapter(client, credentials)
        const result = await adapter.submitOrder({
            instrument: "XAUUSD",
            side: "buy",
            quantity: 0.01,
            orderType: "market",
            timeInForce: "gtc",
        })

        expect(result.orderId).toBe("1588140268")
        expect(result.status).toBe("filled")
        expect(result.filledQuantity).toBe(0.01)
        expect(result.fillPrice).toBe(4715.5)
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

    it("closes every MT5 position for the requested symbol", async () => {
        const client = createClient()
        const closedTickets: number[] = []
        client.getPositions = async () => [
            createPosition(1588140268, "XAUUSD", 4715.5),
            createPosition(1588167645, "XAUUSD", 4715.47),
            createPosition(1589000000, "US30.cash", 39000),
        ]
        client.closePosition = async ({ ticket }): Promise<MT5OrderResult> => {
            closedTickets.push(ticket)

            return {
                retcode: 10009,
                retcodeDescription: "Request completed",
                orderId: String(ticket),
                dealId: String(ticket),
                volume: 0.01,
                price: ticket === 1588140268 ? 4719 : 4718.5,
                success: true,
            }
        }

        const adapter = new MT5VenueAdapter(client, credentials)
        const result = await adapter.closePosition("XAUUSD")

        expect(closedTickets).toEqual([1588140268, 1588167645])
        expect(result.orderId).toBe("1588140268,1588167645")
        expect(result.status).toBe("filled")
        expect(result.filledQuantity).toBe(0.02)
        expect(result.fillPrice).toBe(4718.75)
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
                profit: -47.6,
                entry: 1,
                reason: 4,
            },
        }])
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

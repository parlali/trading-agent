import { describe, expect, it } from "vitest"
import {
    filterPositionsByOwnershipScope,
    filterWorkingOrdersByOwnershipScope,
} from "./position-filter"
import type { Position, WorkingOrder } from "./types"

describe("provider ownership scope filters", () => {
    it("uses exact provider position keys while keeping newly owned instruments visible", () => {
        const positions: Position[] = [
            {
                instrument: "XAUUSD",
                providerPositionId: "1600791764",
                side: "long",
                quantity: 0.01,
                entryPrice: 3330,
            },
            {
                instrument: "XAUUSD",
                providerPositionId: "1600791765",
                side: "short",
                quantity: 0.01,
                entryPrice: 3340,
            },
            {
                instrument: "EURUSD",
                providerPositionId: "2600791765",
                side: "long",
                quantity: 0.01,
                entryPrice: 1.09,
            },
        ]

        expect(filterPositionsByOwnershipScope(positions, {
            instruments: new Set(["XAUUSD", "EURUSD"]),
            positionKeys: new Set(["XAUUSD:1600791764"]),
            workingOrderIds: new Set(),
        })).toEqual([positions[0], positions[2]])
    })

    it("uses exact working-order ids while keeping newly owned instruments visible", () => {
        const orders: WorkingOrder[] = [
            {
                orderId: "order:BTC-USDT-SWAP:btc-owned",
                instrument: "BTC-USDT-SWAP",
                status: "pending",
                quantity: 0.1,
                filledQuantity: 0,
                remainingQuantity: 0.1,
                submittedAt: 1,
                updatedAt: 1,
            },
            {
                orderId: "order:BTC-USDT-SWAP:btc-other",
                instrument: "BTC-USDT-SWAP",
                status: "pending",
                quantity: 0.1,
                filledQuantity: 0,
                remainingQuantity: 0.1,
                submittedAt: 1,
                updatedAt: 1,
            },
            {
                orderId: "order:ETH-USDT-SWAP:eth-new",
                instrument: "ETH-USDT-SWAP",
                status: "pending",
                quantity: 0.1,
                filledQuantity: 0,
                remainingQuantity: 0.1,
                submittedAt: 1,
                updatedAt: 1,
            },
        ]

        expect(filterWorkingOrdersByOwnershipScope(orders, {
            instruments: new Set(["BTC-USDT-SWAP", "ETH-USDT-SWAP"]),
            positionKeys: new Set(),
            workingOrderIds: new Set(["order:BTC-USDT-SWAP:btc-owned"]),
        })).toEqual([orders[0], orders[2]])
    })
})

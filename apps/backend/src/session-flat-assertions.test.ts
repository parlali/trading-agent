import { describe, expect, it } from "vitest"
import {
    findRemainingOwnedPositionsAfterSessionFlat,
    findRemainingOwnedWorkingOrdersAfterSessionFlat,
} from "./session-flat-assertions"
import type { Position, WorkingOrder } from "@valiq-trading/core"

describe("session-flat provider-sync assertions", () => {
    it("flags only exact strategy-owned working orders that remain live after session flat", () => {
        const orders: WorkingOrder[] = [
            {
                orderId: "order:BTC-USDT-SWAP:owned",
                instrument: "BTC-USDT-SWAP",
                status: "pending",
                quantity: 1,
                filledQuantity: 0,
                remainingQuantity: 1,
                submittedAt: 1,
                updatedAt: 1,
            },
            {
                orderId: "order:BTC-USDT-SWAP:other",
                instrument: "BTC-USDT-SWAP",
                status: "pending",
                quantity: 1,
                filledQuantity: 0,
                remainingQuantity: 1,
                submittedAt: 1,
                updatedAt: 1,
            },
            {
                orderId: "order:BTC-USDT-SWAP:cancelled",
                instrument: "BTC-USDT-SWAP",
                status: "cancelled",
                quantity: 1,
                filledQuantity: 0,
                remainingQuantity: 1,
                submittedAt: 1,
                updatedAt: 1,
            },
        ]

        expect(findRemainingOwnedWorkingOrdersAfterSessionFlat(orders, {
            instruments: new Set(["BTC-USDT-SWAP"]),
            positionKeys: new Set(),
            workingOrderIds: new Set(["order:BTC-USDT-SWAP:owned", "order:BTC-USDT-SWAP:cancelled"]),
        })).toEqual([orders[0]])
    })

    it("flags only exact strategy-owned positions that remain live after session flat", () => {
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
                side: "long",
                quantity: 0.01,
                entryPrice: 3331,
            },
        ]

        expect(findRemainingOwnedPositionsAfterSessionFlat(positions, {
            instruments: new Set(["XAUUSD"]),
            positionKeys: new Set(["XAUUSD:1600791764"]),
            workingOrderIds: new Set(),
        })).toEqual([positions[0]])
    })
})

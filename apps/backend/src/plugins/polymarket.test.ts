import { describe, expect, it, vi } from "vitest"
import {
    createLogger,
    type Position,
} from "@valiq-trading/core"
import type { PolymarketMarketPrice } from "@valiq-trading/polymarket"
import { PolymarketPlugin } from "./polymarket"

const logger = createLogger({ minLevel: "fatal" })

function createMarketPrice(instrument: string, midpoint: number): PolymarketMarketPrice {
    return {
        tokenId: instrument,
        midpoint,
        bestBid: midpoint - 0.01,
        bestAsk: midpoint + 0.01,
        spread: 0.02,
        executionCost: {
            metrics: {
                app: "polymarket",
                instrument,
                instrumentClass: "prediction_market",
                capturedAt: Date.now(),
                regimeKey: "test",
                bestBid: midpoint - 0.01,
                bestAsk: midpoint + 0.01,
                midpoint,
                referencePrice: midpoint,
                absoluteSpread: 0.02,
                nativeSpread: 0.02,
                nativeSpreadUnit: "probability",
                spreadPercent: 4,
                spreadBps: 400,
                liquidityWarning: false,
            },
            status: "normal",
            blockNewEntries: false,
            summary: `${instrument} execution-cost summary`,
        },
    }
}

describe("PolymarketPlugin.preRunHooks", () => {
    it("force-closes only positions priced at or below the loss cap", async () => {
        const breachedPosition: Position = {
            instrument: "token-loss",
            side: "long",
            quantity: 10,
            entryPrice: 0.72,
            metadata: {
                question: "Will the breached market resolve no?",
                outcome: "No",
            },
        }
        const safePosition: Position = {
            instrument: "token-safe",
            side: "long",
            quantity: 10,
            entryPrice: 0.72,
            metadata: {
                question: "Will the safe market resolve no?",
                outcome: "No",
            },
        }
        const sessionFlatExecute = vi.fn(async () => ({
            cancelled: 0,
            closed: 1,
            cancelResults: [],
            closeResults: [{
                orderId: "close-token-loss",
                status: "filled" as const,
                filledQuantity: 10,
                timestamp: Date.now(),
            }],
        }))

        const result = await new PolymarketPlugin().preRunHooks({
            venue: {
                getMarketPrice: vi.fn(async (instrument: string) =>
                    createMarketPrice(instrument, instrument === "token-loss" ? 0.5 : 0.6)
                ),
            } as never,
            policy: {
                lossExitPrice: 0.55,
            },
            strategyId: "pm-geo",
            ownedInstruments: new Set(["token-loss", "token-safe"]),
            ownedPositions: [breachedPosition, safePosition],
            ownedWorkingOrders: [],
            strategyAccountState: {
                balance: 1000,
                equity: 1000,
                buyingPower: 1000,
                marginUsed: 0,
                marginAvailable: 1000,
                openPnl: 0,
                dayPnl: 0,
            },
            logger,
            createAlert: vi.fn(async () => {}),
            sessionFlat: {
                execute: sessionFlatExecute,
            },
        })

        expect(result).toMatchObject({
            skip: false,
            providerStateChanged: true,
        })
        expect(sessionFlatExecute).toHaveBeenCalledTimes(1)
        expect(sessionFlatExecute).toHaveBeenCalledWith({
            positions: [breachedPosition],
            workingOrders: [],
            reason: "Loss cap 0.55 breached",
        })
    })
})

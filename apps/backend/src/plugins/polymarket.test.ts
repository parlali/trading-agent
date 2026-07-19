import { describe, expect, it, vi } from "vitest"
import {
    createLogger,
    type Position,
} from "@valiq-trading/core"
import type { PolymarketMarketPrice } from "@valiq-trading/polymarket"
import { PolymarketPlugin } from "./polymarket"

const logger = createLogger({ minLevel: "fatal" })

function createMarketPrice(args: {
    instrument: string
    bestBid: number
    bestAsk: number
    midpoint?: number
    lastTradePrice?: number
    liquidityWarning?: boolean
}): PolymarketMarketPrice {
    const midpoint = args.midpoint ?? (args.bestBid + args.bestAsk) / 2
    const spread = Math.max(args.bestAsk - args.bestBid, 0)

    return {
        tokenId: args.instrument,
        midpoint,
        bestBid: args.bestBid,
        bestAsk: args.bestAsk,
        spread,
        lastTradePrice: args.lastTradePrice,
        liquidityWarning: args.liquidityWarning,
        executionCost: {
            metrics: {
                app: "polymarket",
                instrument: args.instrument,
                instrumentClass: "prediction_market",
                capturedAt: Date.now(),
                regimeKey: "test",
                bestBid: args.bestBid,
                bestAsk: args.bestAsk,
                midpoint,
                referencePrice: midpoint,
                absoluteSpread: spread,
                nativeSpread: spread,
                nativeSpreadUnit: "probability",
                spreadPercent: 4,
                spreadBps: 400,
                liquidityWarning: args.liquidityWarning ?? false,
            },
            status: "normal",
            blockNewEntries: false,
            summary: `${args.instrument} execution-cost summary`,
        },
    }
}

describe("PolymarketPlugin.preRunHooks", () => {
    it("evaluates loss caps from executable bid context instead of last trade", async () => {
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
                getMarketPrice: vi.fn(async (instrument: string) => {
                    if (instrument === "token-loss") {
                        return createMarketPrice({
                            instrument,
                            bestBid: 0.5,
                            bestAsk: 0.54,
                            lastTradePrice: 0.3,
                        })
                    }

                    return createMarketPrice({
                        instrument,
                        bestBid: 0.7,
                        bestAsk: 0.72,
                        lastTradePrice: 0.3,
                    })
                }),
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

    it("leaves a long position open when only last trade breaches the loss cap", async () => {
        const position: Position = {
            instrument: "token-safe-last-trade",
            side: "long",
            quantity: 10,
            entryPrice: 0.72,
            metadata: {
                question: "Will last trade be ignored?",
                outcome: "No",
            },
        }
        const sessionFlatExecute = vi.fn()
        const createAlert = vi.fn(async (_alert: { message: string }) => {})

        const result = await new PolymarketPlugin().preRunHooks({
            venue: {
                getMarketPrice: vi.fn(async (instrument: string) =>
                    createMarketPrice({
                        instrument,
                        bestBid: 0.7,
                        bestAsk: 0.72,
                        lastTradePrice: 0.3,
                    })
                ),
            } as never,
            policy: {
                lossExitPrice: 0.55,
            },
            strategyId: "pm-geo",
            ownedInstruments: new Set(["token-safe-last-trade"]),
            ownedPositions: [position],
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
            createAlert,
            sessionFlat: {
                execute: sessionFlatExecute,
            },
        })

        expect(result.providerStateChanged).toBeUndefined()
        expect(sessionFlatExecute).not.toHaveBeenCalled()
        expect(createAlert).not.toHaveBeenCalled()
    })

    it("does not flatten unevaluable Polymarket loss-cap books and emits alerts", async () => {
        const noBidPosition: Position = {
            instrument: "token-no-bid",
            side: "long",
            quantity: 10,
            entryPrice: 0.72,
            metadata: {
                question: "Will no-bid market be left open?",
                outcome: "No",
            },
        }
        const wideBookPosition: Position = {
            instrument: "token-wide-book",
            side: "long",
            quantity: 10,
            entryPrice: 0.72,
            metadata: {
                question: "Will wide-book market be left open?",
                outcome: "No",
            },
        }
        const sessionFlatExecute = vi.fn()
        const createAlert = vi.fn(async (_alert: { message: string }) => {})

        const result = await new PolymarketPlugin().preRunHooks({
            venue: {
                getMarketPrice: vi.fn(async (instrument: string) => {
                    if (instrument === "token-no-bid") {
                        return createMarketPrice({
                            instrument,
                            bestBid: 0,
                            bestAsk: 0.54,
                        })
                    }

                    return createMarketPrice({
                        instrument,
                        bestBid: 0.7,
                        bestAsk: 0.96,
                        midpoint: 0.53,
                    })
                }),
            } as never,
            policy: {
                lossExitPrice: 0.55,
            },
            strategyId: "pm-geo",
            ownedInstruments: new Set(["token-no-bid", "token-wide-book"]),
            ownedPositions: [noBidPosition, wideBookPosition],
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
            createAlert,
            sessionFlat: {
                execute: sessionFlatExecute,
            },
        })

        expect(result.providerStateChanged).toBeUndefined()
        expect(sessionFlatExecute).not.toHaveBeenCalled()
        expect(createAlert).toHaveBeenCalledTimes(2)
        expect(createAlert.mock.calls.map((call) => call[0]!.message)).toEqual([
            expect.stringContaining("book has no executable bid"),
            expect.stringContaining("book spread 0.2600 exceeds loss-cap evaluation limit 0.05"),
        ])
    })
})

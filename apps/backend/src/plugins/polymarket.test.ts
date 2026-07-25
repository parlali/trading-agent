import { describe, expect, it, vi } from "vitest"
import {
    createLogger,
    type Position,
} from "@valiq-trading/core"
import type { PolymarketMarketPrice } from "@valiq-trading/polymarket"
import type { PreRunHookConfig } from "../types"
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

function createPosition(args: {
    instrument: string
    question: string
    outcome?: string
}): Position {
    return {
        instrument: args.instrument,
        side: "long",
        quantity: 10,
        entryPrice: 0.72,
        metadata: {
            question: args.question,
            outcome: args.outcome ?? "No",
        },
    }
}

function createPreRunHookConfig(args: {
    positions: Position[]
    getMarketPrice: (instrument: string) => PolymarketMarketPrice | Promise<PolymarketMarketPrice>
    createAlert: PreRunHookConfig["createAlert"]
    sessionFlatExecute?: NonNullable<PreRunHookConfig["sessionFlat"]>["execute"]
    strategyId?: string
}): PreRunHookConfig {
    return {
        venue: {
            getMarketPrice: vi.fn(args.getMarketPrice),
        } as never,
        policy: {
            lossExitPrice: 0.55,
        },
        strategyId: args.strategyId ?? "pm-geo",
        ownedInstruments: new Set(args.positions.map((position) => position.instrument)),
        ownedPositions: args.positions,
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
        createAlert: args.createAlert,
        sessionFlat: {
            execute: args.sessionFlatExecute ?? createSessionFlatExecute(),
        },
    }
}

function createSessionFlatExecute() {
    return vi.fn(async () => ({
        cancelled: 0,
        closed: 0,
        cancelResults: [],
        closeResults: [],
    }))
}

async function runLossCapPreRun(args: {
    plugin: PolymarketPlugin
    position: Position
    marketPrice: PolymarketMarketPrice
    createAlert: PreRunHookConfig["createAlert"]
    sessionFlatExecute: NonNullable<PreRunHookConfig["sessionFlat"]>["execute"]
}) {
    return await args.plugin.preRunHooks(createPreRunHookConfig({
        positions: [args.position],
        getMarketPrice: () => args.marketPrice,
        createAlert: args.createAlert,
        sessionFlatExecute: args.sessionFlatExecute,
    }))
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

    it("alerts once when the same position stays unevaluable across consecutive evaluations", async () => {
        const plugin = new PolymarketPlugin()
        const position = createPosition({
            instrument: "token-repeated-wide-book",
            question: "Will repeated wide book be left open?",
        })
        const createAlert = vi.fn(async (_alert: { message: string }) => {})
        const sessionFlatExecute = createSessionFlatExecute()
        const results = []

        for (let index = 0; index < 3; index += 1) {
            results.push(await runLossCapPreRun({
                plugin,
                position,
                marketPrice: createMarketPrice({
                    instrument: position.instrument,
                    bestBid: 0.7,
                    bestAsk: 0.77,
                    midpoint: 0.53,
                }),
                createAlert,
                sessionFlatExecute,
            }))
        }

        expect(sessionFlatExecute).not.toHaveBeenCalled()
        expect(createAlert).toHaveBeenCalledTimes(1)
        expect(createAlert.mock.calls[0]![0]!.message).toContain("Polymarket loss cap unevaluable")
        for (const result of results) {
            expect(result.runtimeContextLines).toEqual(expect.arrayContaining([
                expect.stringContaining("LOSS CAP UNEVALUABLE: Will repeated wide book be left open? [No]"),
            ]))
        }
    })

    it("alerts once on recovery and alerts again when the position becomes unevaluable later", async () => {
        const plugin = new PolymarketPlugin()
        const position = createPosition({
            instrument: "token-recovers-then-wide",
            question: "Will recovered wide book be left open?",
        })
        const createAlert = vi.fn(async (_alert: { severity: string; message: string }) => {})
        const sessionFlatExecute = createSessionFlatExecute()

        for (const marketPrice of [
            createMarketPrice({
                instrument: position.instrument,
                bestBid: 0.7,
                bestAsk: 0.77,
                midpoint: 0.53,
            }),
            createMarketPrice({
                instrument: position.instrument,
                bestBid: 0.7,
                bestAsk: 0.72,
            }),
            createMarketPrice({
                instrument: position.instrument,
                bestBid: 0.7,
                bestAsk: 0.72,
            }),
            createMarketPrice({
                instrument: position.instrument,
                bestBid: 0.7,
                bestAsk: 0.77,
                midpoint: 0.53,
            }),
        ]) {
            await runLossCapPreRun({
                plugin,
                position,
                marketPrice,
                createAlert,
                sessionFlatExecute,
            })
        }

        expect(sessionFlatExecute).not.toHaveBeenCalled()
        expect(createAlert).toHaveBeenCalledTimes(3)
        expect(createAlert.mock.calls.map((call) => call[0]!.message)).toEqual([
            expect.stringContaining("Polymarket loss cap unevaluable for Will recovered wide book be left open? [No]"),
            "Polymarket loss cap evaluable again for Will recovered wide book be left open? [No]",
            expect.stringContaining("Polymarket loss cap unevaluable for Will recovered wide book be left open? [No]"),
        ])
        expect(createAlert.mock.calls[1]![0]!.severity).toBe("info")
    })

    it("alerts again only when a wide-book reason crosses a new spread band", async () => {
        const plugin = new PolymarketPlugin()
        const position = createPosition({
            instrument: "token-spread-band-change",
            question: "Will spread band changes be reported?",
        })
        const createAlert = vi.fn(async (_alert: { message: string }) => {})
        const sessionFlatExecute = createSessionFlatExecute()

        for (const bestAsk of [0.77, 0.78, 0.82]) {
            await runLossCapPreRun({
                plugin,
                position,
                marketPrice: createMarketPrice({
                    instrument: position.instrument,
                    bestBid: 0.7,
                    bestAsk,
                    midpoint: 0.53,
                }),
                createAlert,
                sessionFlatExecute,
            })
        }

        expect(sessionFlatExecute).not.toHaveBeenCalled()
        expect(createAlert).toHaveBeenCalledTimes(2)
        expect(createAlert.mock.calls.map((call) => call[0]!.message)).toEqual([
            expect.stringContaining("book spread 0.0700 exceeds loss-cap evaluation limit 0.05"),
            expect.stringContaining("book spread 0.1200 exceeds loss-cap evaluation limit 0.05"),
        ])
    })
})

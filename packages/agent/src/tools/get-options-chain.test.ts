import { describe, expect, it, vi } from "vitest"
import type { ExecutionCostAssessment } from "@valiq-trading/core"
import type { AlpacaOptionsVenueAdapter } from "@valiq-trading/alpaca-options"
import { createAlpacaGetOptionsChainTool } from "./get-options-chain"

describe("createAlpacaGetOptionsChainTool", () => {
    it("returns quote and execution-cost evidence without provider tradable verdicts", async () => {
        const executionCost: ExecutionCostAssessment = {
            metrics: {
                app: "alpaca-options",
                instrument: "SPY260424C00650000",
                instrumentClass: "equity_option",
                capturedAt: 1,
                regimeKey: "2026-07-20T00",
                bestBid: 1.1,
                bestAsk: 1.3,
                midpoint: 1.2,
                referencePrice: 1.2,
                absoluteSpread: 0.2,
                nativeSpread: 0.2,
                nativeSpreadUnit: "price",
                spreadPercent: 16.6666666667,
                spreadBps: 1666.66666667,
                liquidityWarning: false,
            },
            ratioToBaseline: 1.25,
            status: "elevated",
            blockNewEntries: false,
            summary: "status ELEVATED",
        }
        const venue = {
            getOptionsChain: vi.fn(async () => ({
                contracts: [{
                    symbol: "SPY260424C00650000",
                    underlyingSymbol: "SPY",
                    expirationDate: "2026-04-24",
                    optionType: "call",
                    strikePrice: 650,
                    status: "active",
                    tradable: true,
                    openInterest: 120,
                }],
                snapshots: {
                    SPY260424C00650000: {
                        latestQuote: {
                            bidPrice: 1.1,
                            askPrice: 1.3,
                            bidSize: 10,
                            askSize: 12,
                        },
                        latestTrade: {
                            price: 1.2,
                            size: 5,
                        },
                    },
                },
            })),
            assessOptionQuoteExecutionCost: vi.fn(() => executionCost),
        } as unknown as AlpacaOptionsVenueAdapter
        const tool = createAlpacaGetOptionsChainTool(venue)

        const result = await tool.handler({
            underlyingSymbol: "spy",
            expirationDate: "2026-04-24",
            limit: 1,
        }) as { contracts: Array<Record<string, unknown>> }
        const contract = result.contracts[0]!
        const cost = contract.executionCost as Record<string, unknown>
        const metrics = cost.metrics as Record<string, unknown>

        expect(contract.tradable).toBeUndefined()
        expect(Object.keys(contract)).not.toContain("tradable")
        expect(contract.bid).toBe(1.1)
        expect(contract.ask).toBe(1.3)
        expect(contract.midpoint as number).toBeCloseTo(1.2)
        expect(cost.ratioToBaseline).toBe(1.25)
        expect(cost.status).toBeUndefined()
        expect(cost.blockNewEntries).toBeUndefined()
        expect(cost.summary).toBeUndefined()
        expect(metrics.absoluteSpread).toBe(0.2)
        expect(metrics.liquidityWarning).toBeUndefined()
    })
})

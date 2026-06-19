import { describe, expect, it, vi } from "vitest"
import { createMT5GetSymbolInfoTool } from "./get-symbol-info-mt5"
import type { MT5VenueAdapter, MT5SymbolInfo } from "@valiq-trading/mt5"

describe("MT5 symbol allow-list tools", () => {
    it("projects and enforces the configured provider-verified symbol set", async () => {
        const venue = {
            getSymbolInfo: vi.fn(async (): Promise<MT5SymbolInfo> => ({
                symbol: "XAUUSD.ecn",
                digits: 2,
                point: 0.01,
                pipSize: 0.1,
                tickValue: 1,
                contractSize: 100,
                currency: "USD",
                description: "Gold",
                spread: 12,
                volumeMin: 0.01,
                volumeMax: 100,
                volumeStep: 0.01,
                fillingMode: 0,
                bid: 2400,
                ask: 2400.12,
            })),
            assessSymbolExecutionCost: vi.fn(async () => ({
                metrics: {},
                status: "ok",
                blockNewEntries: false,
                summary: "ok",
            })),
        } as unknown as MT5VenueAdapter

        const tool = createMT5GetSymbolInfoTool(venue, ["XAUUSD.ecn"])

        expect(tool.parameters.safeParse({ symbol: "XAUUSD.ecn" }).success).toBe(true)
        expect(tool.parameters.safeParse({ symbol: "EURUSD" }).success).toBe(false)
        expect((tool.jsonSchema?.properties as Record<string, { enum?: string[] }>).symbol?.enum).toEqual(["XAUUSD.ecn"])

        await tool.handler({ symbol: "xauusd.ecn" })

        expect(venue.getSymbolInfo).toHaveBeenCalledWith("XAUUSD.ecn")
    })
})

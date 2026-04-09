import { describe, expect, it } from "vitest";
import { createToolContractCatalog, getToolBoundary, getToolCategory, getToolContract, } from "./tool-contracts";
describe("tool contracts", () => {
    it("rejects duplicate contract names", () => {
        expect(() => createToolContractCatalog([
            {
                name: "duplicate_tool",
                category: "execution",
                boundary: "shared",
                owner: "shared",
                compatibleVenues: ["alpaca-options"],
                defaultVariant: {
                    description: "first",
                    parameters: getToolContract("get_positions").parameters,
                    jsonSchema: { type: "object", properties: {} },
                    outputDescription: "first",
                    errorSemantics: "first",
                },
            },
            {
                name: "duplicate_tool",
                category: "execution",
                boundary: "shared",
                owner: "shared",
                compatibleVenues: ["alpaca-options"],
                defaultVariant: {
                    description: "second",
                    parameters: getToolContract("get_positions").parameters,
                    jsonSchema: { type: "object", properties: {} },
                    outputDescription: "second",
                    errorSemantics: "second",
                },
            },
        ])).toThrow("Duplicate tool contract definition detected for duplicate_tool");
    });
    it("documents shared and venue-owned boundaries explicitly", () => {
        expect(getToolBoundary("get_positions")).toBe("shared");
        expect(getToolBoundary("get_market_price")).toBe("venue-owned");
        expect(getToolCategory("propose_order")).toBe("execution");
    });
    it("resolves venue-specific variants from one canonical source", () => {
        const mt5Order = getToolContract("propose_order", "mt5");
        const binanceOrder = getToolContract("propose_order", "binance-futures");
        const polymarketMarketPrice = getToolContract("get_market_price", "polymarket");
        expect(mt5Order.description).toContain("MT5");
        expect(binanceOrder.description).toContain("Binance futures");
        expect(polymarketMarketPrice.description).toContain("Polymarket");
    });
});

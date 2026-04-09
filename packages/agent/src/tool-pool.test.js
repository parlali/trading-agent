import { describe, expect, it } from "vitest";
import { createToolDefinition, getToolCategory } from "./tool-contracts";
import { ToolPool } from "./tool-pool";
describe("ToolPool", () => {
    it("fails fast when the same tool name is registered twice for one venue", () => {
        const pool = new ToolPool();
        pool.registerFactory({
            name: "get_positions",
            category: getToolCategory("get_positions"),
            compatibleVenues: ["alpaca-options"],
            create: () => createToolDefinition({
                name: "get_positions",
                handler: async () => ({ positions: [] }),
            }),
        });
        pool.registerFactory({
            name: "get_positions",
            category: getToolCategory("get_positions"),
            compatibleVenues: ["alpaca-options"],
            create: () => createToolDefinition({
                name: "get_positions",
                handler: async () => ({ positions: [] }),
            }),
        });
        expect(() => pool.forVenue("alpaca-options")).toThrow("Duplicate tool registration detected for get_positions on venue alpaca-options");
    });
});

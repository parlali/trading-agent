import { describe, expect, it } from "vitest";
import { mt5OrderParamsSchema } from "./mt5-order-helpers";
const baseParams = {
    instrument: "XAUUSD",
    side: "buy",
    orderType: "market",
    stopLoss: 3200,
    reason: "test",
};
describe("mt5OrderParamsSchema", () => {
    it("accepts takeProfit without riskRewardRatio", () => {
        const parsed = mt5OrderParamsSchema.parse({
            ...baseParams,
            takeProfit: 3300,
        });
        expect(parsed.takeProfit).toBe(3300);
        expect(parsed.riskRewardRatio).toBeUndefined();
    });
    it("accepts riskRewardRatio when takeProfit is null", () => {
        const parsed = mt5OrderParamsSchema.parse({
            ...baseParams,
            takeProfit: null,
            riskRewardRatio: 2,
        });
        expect(parsed.takeProfit).toBeUndefined();
        expect(parsed.riskRewardRatio).toBe(2);
    });
    it("rejects requests that provide both takeProfit and riskRewardRatio", () => {
        expect(() => mt5OrderParamsSchema.parse({
            ...baseParams,
            takeProfit: 3300,
            riskRewardRatio: 2,
        })).toThrow("Provide exactly one of takeProfit or riskRewardRatio");
    });
});

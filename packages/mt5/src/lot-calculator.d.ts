import type { MT5SymbolInfo } from "./mt5-client";
export interface LotSizeInput {
    accountBalance: number;
    maxRiskPercent: number;
    entryPrice: number;
    stopLossPrice: number;
    side: "buy" | "sell";
    symbolInfo: MT5SymbolInfo;
}
export interface LotSizeResult {
    volume: number;
    riskAmount: number;
    riskPercent: number;
    slDistancePoints: number;
}
export declare function calculateLotSize(input: LotSizeInput): LotSizeResult | {
    error: string;
};
export declare function computeTakeProfitFromRR(entryPrice: number, stopLossPrice: number, riskRewardRatio: number, side: "buy" | "sell"): number;
export declare function computeImpliedRR(entryPrice: number, stopLossPrice: number, takeProfitPrice: number, side: "buy" | "sell"): number | {
    error: string;
};
//# sourceMappingURL=lot-calculator.d.ts.map
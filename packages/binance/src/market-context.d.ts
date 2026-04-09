export interface BinanceMarketSnapshot {
    instrument: string;
    bid: number;
    ask: number;
    markPrice: number;
    spreadPercent: number;
    fundingRate: number;
}
export declare function createBinanceMarketContextLine(snapshots: readonly BinanceMarketSnapshot[]): string | null;
//# sourceMappingURL=market-context.d.ts.map
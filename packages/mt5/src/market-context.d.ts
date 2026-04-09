import type { MT5Policy } from "@valiq-trading/core";
import type { MT5SymbolInfo } from "./mt5-client";
export interface MT5MarketSnapshot {
    instrument: string;
    bid: number;
    ask: number;
    spreadPips: number;
}
export declare function resolveMT5InstrumentRegions(policy: MT5Policy): Record<string, string[]>;
export declare function createMT5SpreadContextLine(snapshots: readonly MT5MarketSnapshot[]): string | null;
export declare function toMT5MarketSnapshot(symbolInfo: MT5SymbolInfo): MT5MarketSnapshot;
//# sourceMappingURL=market-context.d.ts.map
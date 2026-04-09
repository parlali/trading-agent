import { type RiskValidator } from "@valiq-trading/core";
interface ParsedOptionContract {
    underlying: string;
    expiration: string;
    optionType: "call" | "put";
    strike: number;
}
export declare const alpacaRiskValidators: readonly RiskValidator[];
export declare function buildIronCondorInstrument(underlying: string, expiration: string, quantity: number): string;
export declare function parseOptionContractSymbol(symbol: string): ParsedOptionContract | null;
export {};
//# sourceMappingURL=risk-rules.d.ts.map
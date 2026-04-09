import { type TradingBackendClient, type DeleteAllStrategiesResult } from "@valiq-trading/convex";
import type { StrategyConfig } from "@valiq-trading/core";
export declare function resolveArg(name: string): string | undefined;
export declare function requireArg(name: string): string;
export declare function createClient(): TradingBackendClient;
export declare function resolveDocumentPath(): string;
export declare function loadStrategiesFromDocument(): Promise<StrategyConfig[]>;
export declare function getStrategyModel(strategy: {
    policy: Record<string, unknown>;
}): string;
export declare function findStrategyByName(strategies: StrategyConfig[], name: string): StrategyConfig;
export declare function printDeleteCounts(deleted: DeleteAllStrategiesResult): void;
export declare function runScript(main: () => Promise<void>): void;
//# sourceMappingURL=strategy-cli.d.ts.map
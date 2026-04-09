import { type DeleteStrategyResult, type Id, type StoredStrategy, type TradingBackendClient } from "@valiq-trading/convex";
export interface SafeStrategyResetResult {
    strategy: StoredStrategy;
    deleted: DeleteStrategyResult;
    cancelledOrders: number;
    closedPositions: number;
}
export declare function resetStrategySafely(client: TradingBackendClient, strategyId: Id<"strategies">): Promise<SafeStrategyResetResult>;
//# sourceMappingURL=safe-strategy-reset.d.ts.map
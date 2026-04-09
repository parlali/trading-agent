import type { BinanceVenueAdapter } from "@valiq-trading/binance";
import { type ExecutionPipeline } from "@valiq-trading/core";
import type { ToolDefinition } from "../tool-registry";
export declare function createBinanceProposeAdjustmentTool(pipeline: ExecutionPipeline, venue: BinanceVenueAdapter, options?: {
    dryRun?: boolean;
}): ToolDefinition;
//# sourceMappingURL=propose-adjustment-binance.d.ts.map
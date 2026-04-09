import type { ExecutionPipeline, Position } from "@valiq-trading/core";
import type { MT5VenueAdapter } from "@valiq-trading/mt5";
import type { BinanceVenueAdapter } from "@valiq-trading/binance";
import type { ToolDefinition } from "../tool-registry";
import { type PolymarketPriceProvider } from "./polymarket-order-helpers";
interface ClosePriceResolverContext {
    instrument: string;
    reason: string;
    closeSide: "buy" | "sell";
    position: Position | undefined;
}
interface CreateProposeCloseToolOptions {
    resolveEstimatedPrice?: (context: ClosePriceResolverContext) => Promise<number | undefined>;
}
export declare function createProposeCloseTool(pipeline: ExecutionPipeline, options?: CreateProposeCloseToolOptions): ToolDefinition;
export declare function createPolymarketProposeCloseTool(pipeline: ExecutionPipeline, venue: PolymarketPriceProvider): ToolDefinition;
export declare function createMT5ProposeCloseTool(pipeline: ExecutionPipeline, venue: MT5VenueAdapter): ToolDefinition;
export declare function createBinanceProposeCloseTool(pipeline: ExecutionPipeline, venue: BinanceVenueAdapter): ToolDefinition;
export {};
//# sourceMappingURL=propose-close.d.ts.map
import { type ExecutionPipeline } from "@valiq-trading/core";
import type { ToolDefinition } from "../tool-registry";
interface CreateProposeOrderToolOptions {
    mode?: "default" | "alpaca-options";
}
export declare function createProposeOrderTool(pipeline: ExecutionPipeline, options?: CreateProposeOrderToolOptions): ToolDefinition;
export {};
//# sourceMappingURL=propose-order.d.ts.map
import type { ExecutionPipeline } from "@valiq-trading/core";
import type { ToolDefinition } from "../tool-registry";
interface CreateModifyOrderToolOptions {
    mode?: "default" | "alpaca-options";
}
export declare function createModifyOrderTool(pipeline: ExecutionPipeline, options?: CreateModifyOrderToolOptions): ToolDefinition;
export {};
//# sourceMappingURL=modify-order.d.ts.map
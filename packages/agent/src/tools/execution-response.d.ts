import type { ExecutionResult, OrderSnapshot, ValidationResult } from "@valiq-trading/core";
export declare function toExecutionToolResult(result: ExecutionResult, options?: {
    trackedOrder?: OrderSnapshot | null;
    validation?: ValidationResult;
    extra?: Record<string, unknown>;
}): Record<string, unknown>;
//# sourceMappingURL=execution-response.d.ts.map
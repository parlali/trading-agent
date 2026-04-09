import type { AccountState, ExecutionErrorDetail, ExecutionErrorSource } from "./types";
export declare function generateRunId(): string;
export declare function now(): number;
export declare class OperationTimeoutError extends Error {
    readonly timeoutMs: number;
    readonly operation: string;
    readonly executionError: ExecutionErrorDetail;
    constructor(operation: string, timeoutMs: number);
}
export declare function createExecutionErrorDetail(source: ExecutionErrorSource, message: string, options?: {
    code?: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
}): ExecutionErrorDetail;
export declare function createExecutionError(source: ExecutionErrorSource, message: string, options?: {
    code?: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
}): Error & {
    executionError: ExecutionErrorDetail;
};
export declare function formatExecutionError(detail: ExecutionErrorDetail): string;
export declare function getErrorMessage(error: unknown): string;
export declare function getExecutionErrorDetail(error: unknown): ExecutionErrorDetail | undefined;
export declare function getAccountEquity(state: AccountState): number;
export declare function getRiskBudgetBase(state: AccountState): number;
export declare function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number, name: string): Promise<T>;
export declare function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit | undefined, timeoutMs: number, operation: string): Promise<Response>;
export declare function retryWithBackoff<T>(fn: () => Promise<T>, maxRetries?: number, baseDelay?: number): Promise<T>;
//# sourceMappingURL=utils.d.ts.map
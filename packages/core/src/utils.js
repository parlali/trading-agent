export function generateRunId() {
    return globalThis.crypto.randomUUID();
}
export function now() {
    return Date.now();
}
export class OperationTimeoutError extends Error {
    timeoutMs;
    operation;
    executionError;
    constructor(operation, timeoutMs) {
        super(`${operation} timed out after ${Math.round(timeoutMs / 1000)}s`);
        this.name = "OperationTimeoutError";
        this.timeoutMs = timeoutMs;
        this.operation = operation;
        this.executionError = createExecutionErrorDetail("timeout", this.message, {
            code: "TIMEOUT",
            retryable: true,
            details: {
                operation,
                timeoutMs,
            },
        });
    }
}
export function createExecutionErrorDetail(source, message, options = {}) {
    return {
        source,
        message,
        code: options.code,
        retryable: options.retryable,
        details: options.details,
    };
}
export function createExecutionError(source, message, options = {}) {
    const executionError = createExecutionErrorDetail(source, message, options);
    const error = new Error(formatExecutionError(executionError));
    error.executionError = executionError;
    return error;
}
export function formatExecutionError(detail) {
    return detail.code
        ? `${detail.message} (code: ${detail.code})`
        : detail.message;
}
export function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export function getExecutionErrorDetail(error) {
    if (error && typeof error === "object" && "executionError" in error) {
        const executionError = error.executionError;
        if (executionError) {
            return executionError;
        }
    }
    if (error instanceof OperationTimeoutError) {
        return error.executionError;
    }
    if (error instanceof TypeError && /fetch|network|socket|econn|etimedout|enotfound/i.test(error.message)) {
        return createExecutionErrorDetail("network", error.message, {
            retryable: true,
        });
    }
    return undefined;
}
export function getAccountEquity(state) {
    return Number.isFinite(state.equity) ? state.equity : state.balance + state.openPnl;
}
export function getRiskBudgetBase(state) {
    const equity = getAccountEquity(state);
    if (equity > 0) {
        return equity;
    }
    return state.balance;
}
export async function withTimeout(operation, timeoutMs, name) {
    return await new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(new OperationTimeoutError(name, timeoutMs));
        }, timeoutMs);
        void operation()
            .then((value) => {
            clearTimeout(timeoutId);
            resolve(value);
        })
            .catch((error) => {
            clearTimeout(timeoutId);
            reject(error);
        });
    });
}
export async function fetchWithTimeout(input, init = {}, timeoutMs, operation) {
    const controller = new AbortController();
    const parentSignal = init.signal;
    let timedOut = false;
    const abortFromParent = () => {
        controller.abort(parentSignal?.reason);
    };
    if (parentSignal) {
        if (parentSignal.aborted) {
            abortFromParent();
        }
        else {
            parentSignal.addEventListener("abort", abortFromParent, { once: true });
        }
    }
    const timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
    try {
        return await fetch(input, {
            ...init,
            signal: controller.signal,
        });
    }
    catch (error) {
        if (timedOut) {
            throw new OperationTimeoutError(operation, timeoutMs);
        }
        throw error;
    }
    finally {
        clearTimeout(timeoutId);
        parentSignal?.removeEventListener("abort", abortFromParent);
    }
}
export async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        }
        catch (error) {
            lastError = error;
            if (attempt < maxRetries) {
                const delay = baseDelay * Math.pow(2, attempt);
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
    }
    throw lastError;
}

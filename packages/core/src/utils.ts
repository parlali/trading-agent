import type { AccountState, ExecutionErrorDetail, ExecutionErrorSource } from "./types"

export function generateRunId(): string {
    return globalThis.crypto.randomUUID()
}

export function now(): number {
    return Date.now()
}

export class OperationTimeoutError extends Error {
    readonly timeoutMs: number
    readonly operation: string
    readonly executionError: ExecutionErrorDetail

    constructor(operation: string, timeoutMs: number) {
        super(`${operation} timed out after ${Math.round(timeoutMs / 1000)}s`)
        this.name = "OperationTimeoutError"
        this.timeoutMs = timeoutMs
        this.operation = operation
        this.executionError = createExecutionErrorDetail("timeout", this.message, {
            code: "TIMEOUT",
            retryable: true,
            details: {
                operation,
                timeoutMs,
            },
        })
    }
}

export function createExecutionErrorDetail(
    source: ExecutionErrorSource,
    message: string,
    options: {
        code?: string
        retryable?: boolean
        details?: Record<string, unknown>
    } = {}
): ExecutionErrorDetail {
    return {
        source,
        message,
        code: options.code,
        retryable: options.retryable,
        details: options.details,
    }
}

export function createExecutionError(
    source: ExecutionErrorSource,
    message: string,
    options: {
        code?: string
        retryable?: boolean
        details?: Record<string, unknown>
    } = {}
): Error & { executionError: ExecutionErrorDetail } {
    const executionError = createExecutionErrorDetail(source, message, options)
    const error = new Error(formatExecutionError(executionError)) as Error & { executionError: ExecutionErrorDetail }
    error.executionError = executionError
    return error
}

export function formatExecutionError(detail: ExecutionErrorDetail): string {
    return detail.code
        ? `${detail.message} (code: ${detail.code})`
        : detail.message
}

export function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

export function getExecutionErrorDetail(error: unknown): ExecutionErrorDetail | undefined {
    if (error && typeof error === "object" && "executionError" in error) {
        const executionError = (error as { executionError?: ExecutionErrorDetail }).executionError
        if (executionError) {
            return executionError
        }
    }

    if (error instanceof OperationTimeoutError) {
        return error.executionError
    }

    if (error instanceof TypeError && /fetch|network|socket|econn|etimedout|enotfound/i.test(error.message)) {
        return createExecutionErrorDetail("network", error.message, {
            retryable: true,
        })
    }

    return undefined
}

export function getAccountEquity(state: AccountState): number {
    return Number.isFinite(state.equity) ? state.equity : state.balance + state.openPnl
}

export function getRiskBudgetBase(state: AccountState): number {
    const equity = getAccountEquity(state)
    if (equity > 0) {
        return equity
    }

    return state.balance
}

export async function withTimeout<T>(
    operation: () => Promise<T>,
    timeoutMs: number,
    name: string
): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(new OperationTimeoutError(name, timeoutMs))
        }, timeoutMs)

        void operation()
            .then((value) => {
                clearTimeout(timeoutId)
                resolve(value)
            })
            .catch((error) => {
                clearTimeout(timeoutId)
                reject(error)
            })
    })
}

export async function fetchWithTimeout(
    input: RequestInfo | URL,
    init: RequestInit = {},
    timeoutMs: number,
    operation: string
): Promise<Response> {
    const controller = new AbortController()
    const parentSignal = init.signal
    let timedOut = false

    const abortFromParent = () => {
        controller.abort(parentSignal?.reason)
    }

    if (parentSignal) {
        if (parentSignal.aborted) {
            abortFromParent()
        } else {
            parentSignal.addEventListener("abort", abortFromParent, { once: true })
        }
    }

    const timeoutId = setTimeout(() => {
        timedOut = true
        controller.abort()
    }, timeoutMs)

    try {
        return await fetch(input, {
            ...init,
            signal: controller.signal,
        })
    } catch (error) {
        if (timedOut) {
            throw new OperationTimeoutError(operation, timeoutMs)
        }

        throw error
    } finally {
        clearTimeout(timeoutId)
        parentSignal?.removeEventListener("abort", abortFromParent)
    }
}

export async function retryWithBackoff<T>(
    fn: () => Promise<T>,
    maxRetries = 3,
    baseDelay = 1000
): Promise<T> {
    let lastError: unknown
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn()
        } catch (error) {
            lastError = error
            if (attempt < maxRetries) {
                const delay = baseDelay * Math.pow(2, attempt)
                await new Promise((resolve) => setTimeout(resolve, delay))
            }
        }
    }
    throw lastError
}

export interface ConvexMutationRetryOptions {
    attempts?: number
    delayMs?: number
    onRetry?: (attempt: number, attempts: number, error: unknown) => void
}

export async function retryConvexMutation<T>(
    options: ConvexMutationRetryOptions,
    run: () => Promise<T>
): Promise<T> {
    const attempts = boundRetryAttempts(options.attempts)
    let lastError: unknown

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await run()
        } catch (error) {
            lastError = error
            if (attempt >= attempts || !isRetryableConvexMutationError(error)) {
                throw error
            }

            options.onRetry?.(attempt, attempts, error)
            const delayMs = options.delayMs ?? 0
            if (delayMs > 0) {
                await sleep(delayMs)
            }
        }
    }

    throw lastError
}

export function isRetryableConvexMutationError(error: unknown): boolean {
    const message = error instanceof Error
        ? error.message
        : String(error)
    const code = typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : ""

    return /OptimisticConcurrencyControlFailure|Documents read from or written to|OCC/i.test(message) ||
        /server error|internal server error|service unavailable|gateway timeout|too many requests|timeout|connectionrefused|network|fetch failed|unable to connect/i.test(message) ||
        /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN/i.test(code)
}

export function formatConvexRetryError(error: unknown): string {
    return error instanceof Error
        ? error.message
        : String(error)
}

function boundRetryAttempts(attempts: number | undefined): number {
    return Math.max(1, Math.min(Math.floor(attempts ?? 1), 5))
}

async function sleep(delayMs: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
}

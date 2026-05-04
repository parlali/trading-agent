import { ConvexHttpClient } from "convex/browser"
import { withTimeout } from "@valiq-trading/core"

export interface MachineConvexHttpConfig {
    url: string
    machineAuth?: {
        serviceToken: string
    }
    timeoutMs?: number
}

export function createMachineConvexHttpContext(
    config: MachineConvexHttpConfig,
    authErrorMessage: string
) {
    const client = new ConvexHttpClient(config.url)
    const timeoutMs = config.timeoutMs ?? 30_000

    const requireMachineAuth = (): { serviceToken: string } => {
        const serviceToken = config.machineAuth?.serviceToken?.trim()

        if (!serviceToken) {
            throw new Error(authErrorMessage)
        }

        return { serviceToken }
    }

    const runWithTimeout = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
        return await withTimeout(operation, timeoutMs, name)
    }

    return {
        client,
        requireMachineAuth,
        runWithTimeout,
    }
}

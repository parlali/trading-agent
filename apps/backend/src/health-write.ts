import type { App } from "@valiq-trading/core"
import { backend, logger } from "./state"

type HeartbeatStatus = "healthy" | "degraded" | "unhealthy"

const HEARTBEAT_WRITE_MAX_ATTEMPTS = 3
const HEARTBEAT_WRITE_RETRY_DELAY_MS = 250

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

async function createWriteFailureAlert(args: {
    app: App
    kind: "liveness" | "snapshot"
    message: string
}): Promise<void> {
    try {
        await backend.createAlert({
            app: args.app,
            severity: "warning",
            message: `Heartbeat ${args.kind} write failed for ${args.app}: ${args.message}`,
        })
    } catch (error) {
        logger.error("Failed to create heartbeat write failure alert", {
            app: args.app,
            kind: args.kind,
            error: error instanceof Error ? error.message : String(error),
        })
    }
}

async function runHeartbeatWrite(
    kind: "liveness" | "snapshot",
    app: App,
    operation: () => Promise<void>
): Promise<void> {
    let lastError: string | undefined

    for (let attempt = 1; attempt <= HEARTBEAT_WRITE_MAX_ATTEMPTS; attempt++) {
        try {
            await operation()
            return
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error)
            logger.error("Heartbeat write attempt failed", {
                app,
                kind,
                attempt,
                maxAttempts: HEARTBEAT_WRITE_MAX_ATTEMPTS,
                error: lastError,
            })

            if (attempt < HEARTBEAT_WRITE_MAX_ATTEMPTS) {
                await sleep(HEARTBEAT_WRITE_RETRY_DELAY_MS)
            }
        }
    }

    await createWriteFailureAlert({
        app,
        kind,
        message: lastError ?? "unknown error",
    })
}

export async function writeHeartbeatLiveness(args: {
    app: App
    status: HeartbeatStatus
    metadata?: Record<string, unknown>
}): Promise<void> {
    await runHeartbeatWrite("liveness", args.app, async () => {
        await backend.reportHeartbeatLiveness(args.app, args.status, args.metadata)
    })
}

export async function writeHeartbeatSnapshot(args: {
    app: App
    status: HeartbeatStatus
    metadata: Record<string, unknown>
    force?: boolean
}): Promise<void> {
    await runHeartbeatWrite("snapshot", args.app, async () => {
        const result = await backend.reportHeartbeatSnapshot({
            app: args.app,
            status: args.status,
            metadata: args.metadata,
            force: args.force,
        })

        if (result.suppressed) {
            logger.info("Heartbeat snapshot write suppressed by hash gate", {
                app: args.app,
                metadataHash: result.metadataHash,
                suppressedWrites: result.suppressedWrites,
            })
        }
    })
}

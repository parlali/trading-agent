export type HeartbeatStatus = "healthy" | "degraded" | "unhealthy"

const HEARTBEAT_STATUS_PRIORITY: Record<HeartbeatStatus, number> = {
    healthy: 0,
    degraded: 1,
    unhealthy: 2,
}

export function mergeHeartbeatStatus(
    left: HeartbeatStatus,
    right: HeartbeatStatus
): HeartbeatStatus {
    return HEARTBEAT_STATUS_PRIORITY[left] >= HEARTBEAT_STATUS_PRIORITY[right] ? left : right
}

function canonicalizeJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map((entry) => canonicalizeJsonValue(entry))
    }

    if (value && typeof value === "object") {
        const record = value as Record<string, unknown>
        const normalized: Record<string, unknown> = {}
        const keys = Object.keys(record).sort((left, right) => left.localeCompare(right))
        for (const key of keys) {
            normalized[key] = canonicalizeJsonValue(record[key])
        }
        return normalized
    }

    return value
}

function hashStringFNV1a(value: string): string {
    let hash = 0x811c9dc5

    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
    }

    return (hash >>> 0).toString(16).padStart(8, "0")
}

export function computeHeartbeatMetadataHash(metadata: unknown): string {
    const canonical = JSON.stringify(canonicalizeJsonValue(metadata ?? null))
    return hashStringFNV1a(canonical)
}

export function composeHeartbeatReadModel(args: {
    now: number
    liveness?: {
        status: HeartbeatStatus
        lastHeartbeat: number
        metadata?: unknown
    }
    snapshot?: {
        status: HeartbeatStatus
        lastSnapshotAt: number
        metadata?: unknown
    }
}): {
    status: HeartbeatStatus
    lastHeartbeat: number
    metadata?: unknown
} {
    const livenessStatus = args.liveness?.status ?? "healthy"
    const snapshotStatus = args.snapshot?.status ?? livenessStatus
    const status = mergeHeartbeatStatus(livenessStatus, snapshotStatus)
    const metadata = args.snapshot?.metadata ?? args.liveness?.metadata
    const lastHeartbeat = args.liveness?.lastHeartbeat ?? args.snapshot?.lastSnapshotAt ?? args.now

    return {
        status,
        metadata,
        lastHeartbeat,
    }
}

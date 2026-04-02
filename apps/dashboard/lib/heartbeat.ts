import { STALE_THRESHOLD_MS } from "@/lib/constants"

export function isHeartbeatStale(lastHeartbeat: number): boolean {
    return Date.now() - lastHeartbeat > STALE_THRESHOLD_MS
}

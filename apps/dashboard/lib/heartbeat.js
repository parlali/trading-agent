import { STALE_THRESHOLD_MS } from "@/lib/constants";
export function isHeartbeatStale(lastHeartbeat) {
    return Date.now() - lastHeartbeat > STALE_THRESHOLD_MS;
}

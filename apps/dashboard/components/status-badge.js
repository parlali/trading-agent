import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
const RUN_STATUS_MAP = {
    completed: "default",
    failed: "destructive",
};
const HEALTH_STATUS_MAP = {
    healthy: "default",
    degraded: "secondary",
    stale: "secondary",
};
const EVENT_TYPE_MAP = {
    filled: "default",
    rejected: "destructive",
    cancelled: "destructive",
};
const STATUS_MAPS = {
    run: RUN_STATUS_MAP,
    health: HEALTH_STATUS_MAP,
    event: EVENT_TYPE_MAP,
};
function getStatusBadgeVariant(status, category, fallback = "secondary") {
    return STATUS_MAPS[category][status] ?? fallback;
}
export function StatusBadge({ status, category, fallback = "secondary", className, children, }) {
    return (<Badge variant={getStatusBadgeVariant(status, category, fallback)} className={cn("text-xs", className)}>
            {children ?? status}
        </Badge>);
}
export { getStatusBadgeVariant };

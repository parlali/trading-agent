import { cn } from "@/lib/utils";
const colorMap = {
    healthy: "bg-signal-healthy",
    degraded: "bg-signal-warning",
    unhealthy: "bg-signal-danger",
    running: "bg-signal-warning animate-pulse",
    completed: "bg-signal-healthy",
    failed: "bg-signal-danger",
};
export function StatusDot({ status, className }) {
    const color = colorMap[status] ?? "bg-muted-foreground";
    return (<span className={cn("inline-block h-2 w-2 rounded-full", color, className)} role="status" aria-label={status}/>);
}

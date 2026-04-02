import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "ghost" | "link"

const RUN_STATUS_MAP: Record<string, BadgeVariant> = {
    completed: "default",
    failed: "destructive",
}

const HEALTH_STATUS_MAP: Record<string, BadgeVariant> = {
    healthy: "default",
    degraded: "secondary",
    stale: "secondary",
}

const EVENT_TYPE_MAP: Record<string, BadgeVariant> = {
    filled: "default",
    rejected: "destructive",
    cancelled: "destructive",
}

const STATUS_MAPS = {
    run: RUN_STATUS_MAP,
    health: HEALTH_STATUS_MAP,
    event: EVENT_TYPE_MAP,
} as const

type StatusCategory = keyof typeof STATUS_MAPS

function getStatusBadgeVariant(
    status: string,
    category: StatusCategory,
    fallback: BadgeVariant = "secondary",
): BadgeVariant {
    return STATUS_MAPS[category][status] ?? fallback
}

export function StatusBadge({
    status,
    category,
    fallback = "secondary",
    className,
    children,
}: {
    status: string
    category: StatusCategory
    fallback?: BadgeVariant
    className?: string
    children?: React.ReactNode
}) {
    return (
        <Badge
            variant={getStatusBadgeVariant(status, category, fallback)}
            className={cn("text-xs", className)}
        >
            {children ?? status}
        </Badge>
    )
}

export { getStatusBadgeVariant }
export type { StatusCategory, BadgeVariant }

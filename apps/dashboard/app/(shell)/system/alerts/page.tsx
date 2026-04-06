"use client"

import { useState, useMemo } from "react"
import { useMutation } from "convex/react"
import { api } from "@valiq-trading/convex"
import { useDashboardOverview } from "@/hooks/use-dashboard-overview"
import type { Id } from "@valiq-trading/convex"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { PageSkeleton } from "@/components/page-skeleton"
import { EmptyState } from "@/components/empty-state"
import { FilterBar } from "@/components/filter-bar"
import { formatTimestamp } from "@/lib/format"
import { SEVERITY_COLORS } from "@/lib/constants"
import { AlertTriangle, Check } from "lucide-react"
import { toast } from "sonner"

type SeverityFilter = "all" | "critical" | "warning" | "info"
type AppFilter = string | null
type StatusFilter = "all" | "unacknowledged" | "acknowledged"

const SEVERITY_OPTIONS = ["all", "critical", "warning", "info"] as const
const STATUS_OPTIONS = ["all", "unacknowledged", "acknowledged"] as const

const severityLabel = (v: SeverityFilter) =>
    v === "all" ? "All severities" : v.charAt(0).toUpperCase() + v.slice(1)

const statusLabel = (v: StatusFilter) =>
    v === "all" ? "All" : v.charAt(0).toUpperCase() + v.slice(1)

const appLabel = (v: AppFilter) =>
    v === null ? "All apps" : v

export default function AlertsPage() {
    const { data: overview, isLoading } = useDashboardOverview()
    const acknowledgeAlert = useMutation(api.mutations.acknowledgeAlert)

    const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all")
    const [appFilter, setAppFilter] = useState<AppFilter>(null)
    const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")

    const appOptions = useMemo(() => {
        if (!overview) return [null] as AppFilter[]
        const apps = new Set(
            overview.recentAlerts
                .map((a) => a.app)
                .filter((a) => !!a)
        )
        return [null, ...Array.from(apps).sort()] as AppFilter[]
    }, [overview])

    if (isLoading || !overview) {
        return <PageSkeleton count={5} />
    }

    const alerts = overview.recentAlerts

    if (alerts.length === 0) {
        return (
            <EmptyState
                icon={AlertTriangle}
                title="No alerts"
                description="System alerts will appear here"
            />
        )
    }

    const filtered = alerts.filter((a) => {
        if (severityFilter !== "all" && a.severity !== severityFilter) return false
        if (appFilter !== null && (a.app ?? null) !== appFilter) return false
        if (statusFilter === "unacknowledged" && a.acknowledged) return false
        if (statusFilter === "acknowledged" && !a.acknowledged) return false
        return true
    })

    const unacknowledged = filtered.filter((a) => !a.acknowledged)
    const acknowledged = filtered.filter((a) => a.acknowledged)

    const showSections = statusFilter === "all"

    return (
        <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-4">
                <FilterBar
                    items={SEVERITY_OPTIONS}
                    selected={severityFilter}
                    onSelect={setSeverityFilter}
                    getLabel={severityLabel}
                />
                <FilterBar
                    items={appOptions}
                    selected={appFilter}
                    onSelect={setAppFilter}
                    getLabel={appLabel}
                />
                <FilterBar
                    items={STATUS_OPTIONS}
                    selected={statusFilter}
                    onSelect={setStatusFilter}
                    getLabel={statusLabel}
                />
            </div>

            {filtered.length === 0 ? (
                <EmptyState
                    icon={AlertTriangle}
                    title="No matching alerts"
                    description="Try adjusting your filters"
                />
            ) : null}

            {(showSections ? unacknowledged.length > 0 : statusFilter === "unacknowledged" && filtered.length > 0) ? (
                <div className="space-y-3">
                    {showSections ? (
                        <h3 className="text-sm font-semibold">
                            Unacknowledged ({unacknowledged.length})
                        </h3>
                    ) : null}
                    {(showSections ? unacknowledged : filtered).map((alert) => (
                        <Card key={alert._id} className="border-border-subtle">
                            <CardContent className="flex items-start justify-between py-4">
                                <div className="flex items-start gap-3 min-w-0">
                                    <Badge
                                        variant="outline"
                                        className={`text-xs shrink-0 mt-0.5 ${SEVERITY_COLORS[alert.severity as keyof typeof SEVERITY_COLORS] ?? ""}`}
                                    >
                                        {alert.severity}
                                    </Badge>
                                    <div className="min-w-0">
                                        <p className="text-sm">{alert.message}</p>
                                        <div className="flex items-center gap-2 mt-1">
                                            {alert.app ? (
                                                <Badge variant="outline" className="text-xs">{alert.app}</Badge>
                                            ) : null}
                                            <span className="text-xs text-muted-foreground">
                                                {formatTimestamp(alert.timestamp)}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    className="shrink-0 ml-3"
                                    onClick={() => {
                                        acknowledgeAlert({
                                            alertId: alert._id as Id<"alerts">,
                                        })
                                            .then(() => toast.success("Alert acknowledged"))
                                            .catch(() => toast.error("Failed to acknowledge"))
                                    }}
                                >
                                    <Check className="h-3 w-3 mr-1" />
                                    Ack
                                </Button>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            ) : null}

            {(showSections ? acknowledged.length > 0 : statusFilter === "acknowledged" && filtered.length > 0) ? (
                <div className="space-y-3">
                    {showSections ? (
                        <h3 className="text-sm font-semibold text-muted-foreground">
                            Acknowledged ({acknowledged.length})
                        </h3>
                    ) : null}
                    {(showSections ? acknowledged : filtered).map((alert) => (
                        <Card key={alert._id} className="opacity-60">
                            <CardContent className="flex items-start gap-3 py-4">
                                <Badge
                                    variant="outline"
                                    className={`text-xs shrink-0 mt-0.5 ${SEVERITY_COLORS[alert.severity as keyof typeof SEVERITY_COLORS] ?? ""}`}
                                >
                                    {alert.severity}
                                </Badge>
                                <div className="min-w-0">
                                    <p className="text-sm text-muted-foreground">{alert.message}</p>
                                    <span className="text-xs text-muted-foreground/60">
                                        {formatTimestamp(alert.timestamp)}
                                    </span>
                                </div>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            ) : null}
        </div>
    )
}

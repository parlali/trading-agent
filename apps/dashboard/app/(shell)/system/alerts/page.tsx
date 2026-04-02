"use client"

import { useMutation } from "convex/react"
import { api } from "@valiq-trading/convex"
import { useDashboardOverview } from "@/hooks/use-dashboard-overview"
import type { Id } from "@valiq-trading/convex"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { PageSkeleton } from "@/components/page-skeleton"
import { EmptyState } from "@/components/empty-state"
import { formatTimestamp } from "@/lib/format"
import { SEVERITY_COLORS } from "@/lib/constants"
import { AlertTriangle, Check } from "lucide-react"
import { toast } from "sonner"

export default function AlertsPage() {
    const { data: overview, isLoading } = useDashboardOverview()
    const acknowledgeAlert = useMutation(api.mutations.acknowledgeAlert)

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

    const unacknowledged = alerts.filter((a) => !a.acknowledged)
    const acknowledged = alerts.filter((a) => a.acknowledged)

    return (
        <div className="space-y-6">
            {unacknowledged.length > 0 ? (
                <div className="space-y-3">
                    <h3 className="text-sm font-semibold">
                        Unacknowledged ({unacknowledged.length})
                    </h3>
                    {unacknowledged.map((alert) => (
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

            {acknowledged.length > 0 ? (
                <div className="space-y-3">
                    <h3 className="text-sm font-semibold text-muted-foreground">
                        Acknowledged ({acknowledged.length})
                    </h3>
                    {acknowledged.map((alert) => (
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

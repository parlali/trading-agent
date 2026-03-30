"use client"

import { useQuery, useMutation } from "convex/react"
import { api } from "@valiq-trading/convex"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { VenueBadge } from "@/components/venue-badge"
import { StatusDot } from "@/components/status-dot"
import { EmptyState } from "@/components/empty-state"
import { formatRelativeTime } from "@/lib/format"
import { VENUE_APPS, VENUE_META, type VenueApp } from "@/lib/constants"
import { Layers, Play } from "lucide-react"
import { toast } from "sonner"

export default function StrategiesPage() {
    const overview = useQuery(api.queries.getDashboardOverview)
    const triggerManualRun = useMutation(api.mutations.triggerManualRun)

    if (overview === undefined) {
        return (
            <div className="space-y-4">
                {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-24" />
                ))}
            </div>
        )
    }

    const groupedByVenue = VENUE_APPS.map((app) => ({
        app,
        meta: VENUE_META[app],
        strategies: overview.strategies.filter((s) => s.app === app),
    })).filter((group) => group.strategies.length > 0)

    if (groupedByVenue.length === 0) {
        return (
            <EmptyState
                icon={Layers}
                title="No strategies"
                description="No strategies configured yet"
            />
        )
    }

    return (
        <div className="space-y-6">
            {groupedByVenue.map(({ app, meta, strategies }) => (
                <div key={app} className="space-y-3">
                    <div className="flex items-center gap-2">
                        <meta.icon className="h-4 w-4 text-muted-foreground" />
                        <h3 className="text-sm font-semibold">{meta.label}</h3>
                        <Badge variant="secondary" className="text-xs">
                            {strategies.length}
                        </Badge>
                    </div>
                    <div className="space-y-2">
                        {strategies.map((strategy) => (
                            <Card key={strategy._id}>
                                <CardContent className="flex items-center justify-between py-4">
                                    <div className="flex items-center gap-3 min-w-0">
                                        <StatusDot
                                            status={
                                                strategy.latestRun?.status === "running"
                                                    ? "running"
                                                    : strategy.enabled
                                                        ? "healthy"
                                                        : "unhealthy"
                                            }
                                        />
                                        <div className="min-w-0">
                                            <Link
                                                href={`/strategies/${strategy._id}`}
                                                className="text-sm font-medium hover:underline"
                                            >
                                                {strategy.name}
                                            </Link>
                                            <div className="flex items-center gap-2 mt-1">
                                                <code className="text-xs text-muted-foreground font-mono">
                                                    {strategy.schedule}
                                                </code>
                                                {!strategy.enabled ? (
                                                    <Badge variant="secondary" className="text-xs">disabled</Badge>
                                                ) : null}
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-3 shrink-0">
                                        {strategy.latestRun ? (
                                            <div className="text-right">
                                                <Badge
                                                    variant={
                                                        strategy.latestRun.status === "completed"
                                                            ? "default"
                                                            : strategy.latestRun.status === "failed"
                                                                ? "destructive"
                                                                : "secondary"
                                                    }
                                                    className="text-xs"
                                                >
                                                    {strategy.latestRun.status}
                                                </Badge>
                                                <p className="text-xs text-muted-foreground mt-1">
                                                    {formatRelativeTime(strategy.latestRun.startedAt)}
                                                </p>
                                            </div>
                                        ) : (
                                            <span className="text-xs text-muted-foreground">never run</span>
                                        )}
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            disabled={!strategy.enabled || strategy.latestRun?.status === "running"}
                                            onClick={() => {
                                                triggerManualRun({ strategyId: strategy._id })
                                                    .then(() => toast.success(`Manual run triggered for ${strategy.name}`))
                                                    .catch(() => toast.error("Failed to trigger run"))
                                            }}
                                        >
                                            <Play className="h-3 w-3 mr-1" />
                                            Run
                                        </Button>
                                    </div>
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                </div>
            ))}
        </div>
    )
}

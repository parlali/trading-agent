"use client"

import { useQuery } from "convex/react"
import { api } from "@valiq-trading/convex"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { VenueBadge } from "@/components/venue-badge"
import { StatusDot } from "@/components/status-dot"
import { EmptyState } from "@/components/empty-state"
import { formatTimestamp, formatRelativeTime } from "@/lib/format"
import { History } from "lucide-react"

export default function RunsPage() {
    const overview = useQuery(api.queries.getDashboardOverview)

    if (overview === undefined) {
        return (
            <div className="space-y-3">
                {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-16" />
                ))}
            </div>
        )
    }

    const allRuns = overview.recentRuns
    const strategies = overview.strategies

    if (allRuns.length === 0) {
        return (
            <EmptyState
                icon={History}
                title="No runs yet"
                description="Strategy runs will appear here once executed"
            />
        )
    }

    return (
        <div className="space-y-3">
            {overview.activeRuns.length > 0 ? (
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="text-base flex items-center gap-2">
                            Active Runs
                            <Badge variant="secondary" className="text-xs">
                                {overview.activeRuns.length}
                            </Badge>
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-2">
                            {overview.activeRuns.map((run) => {
                                const strategy = strategies.find(
                                    (s) => String(s._id) === String(run.strategyId),
                                )
                                return (
                                    <Link
                                        key={run._id}
                                        href={`/runs/${run._id}`}
                                        className="flex items-center justify-between rounded-lg border border-signal-warning/30 bg-signal-warning/5 p-3 hover:bg-signal-warning/10 transition-colors"
                                    >
                                        <div className="flex items-center gap-3">
                                            <StatusDot status="running" />
                                            <div>
                                                <p className="text-sm font-medium">{strategy?.name ?? "Unknown"}</p>
                                                <VenueBadge app={run.app} />
                                            </div>
                                        </div>
                                        <span className="text-xs text-muted-foreground">
                                            started {formatRelativeTime(run.startedAt)}
                                        </span>
                                    </Link>
                                )
                            })}
                        </div>
                    </CardContent>
                </Card>
            ) : null}

            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="text-base">Recent Runs</CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="space-y-2">
                        {allRuns.map((run) => {
                            const strategy = strategies.find(
                                (s) => String(s._id) === String(run.strategyId),
                            )
                            return (
                                <Link
                                    key={run._id}
                                    href={`/runs/${run._id}`}
                                    className="flex items-center justify-between rounded-lg border border-border-subtle p-3 hover:bg-muted/50 transition-colors"
                                >
                                    <div className="flex items-center gap-3 min-w-0">
                                        <StatusDot status={run.status} />
                                        <div className="min-w-0">
                                            <p className="text-sm font-medium truncate">
                                                {strategy?.name ?? "Unknown"}
                                            </p>
                                            <div className="flex items-center gap-2 mt-0.5">
                                                <VenueBadge app={run.app} />
                                                {run.endedAt ? (
                                                    <span className="text-xs text-muted-foreground font-mono tabular-nums">
                                                        {Math.round((run.endedAt - run.startedAt) / 1000)}s
                                                    </span>
                                                ) : null}
                                            </div>
                                        </div>
                                    </div>
                                    <div className="text-right shrink-0">
                                        <Badge
                                            variant={
                                                run.status === "completed"
                                                    ? "default"
                                                    : run.status === "failed"
                                                        ? "destructive"
                                                        : "secondary"
                                            }
                                            className="text-xs"
                                        >
                                            {run.status}
                                        </Badge>
                                        <p className="text-xs text-muted-foreground mt-1">
                                            {formatTimestamp(run.startedAt)}
                                        </p>
                                    </div>
                                </Link>
                            )
                        })}
                    </div>
                </CardContent>
            </Card>
        </div>
    )
}

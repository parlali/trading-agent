"use client"

import { use } from "react"
import { useQuery } from "convex/react"
import { api } from "@valiq-trading/convex"
import type { Id } from "@valiq-trading/convex"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { VenueBadge } from "@/components/venue-badge"
import { StatusDot } from "@/components/status-dot"
import { EmptyState } from "@/components/empty-state"
import { formatRelativeTime, formatTimestamp } from "@/lib/format"
import { History } from "lucide-react"

export default function StrategyDetailPage({
    params,
}: {
    params: Promise<{ id: string }>
}) {
    const { id } = use(params)
    const strategy = useQuery(api.queries.getStrategyById, {
        id: id as Id<"strategies">,
    })
    const runs = useQuery(api.queries.getRunHistory, {
        strategyId: id as Id<"strategies">,
        limit: 20,
    })

    if (strategy === undefined || runs === undefined) {
        return (
            <div className="space-y-6">
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-48" />
            </div>
        )
    }

    if (strategy === null) {
        return (
            <div className="flex items-center justify-center py-12">
                <p className="text-sm text-muted-foreground">Strategy not found</p>
            </div>
        )
    }

    return (
        <div className="space-y-6">
            <div className="flex items-center gap-3">
                <h2 className="text-lg font-semibold">{strategy.name}</h2>
                <VenueBadge app={strategy.app} />
                <Badge variant={strategy.enabled ? "default" : "secondary"}>
                    {strategy.enabled ? "enabled" : "disabled"}
                </Badge>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Configuration</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <div>
                            <p className="text-xs text-muted-foreground mb-1">Schedule</p>
                            <code className="text-sm font-mono">{strategy.schedule}</code>
                        </div>
                        <div>
                            <p className="text-xs text-muted-foreground mb-1">Policy</p>
                            <pre className="text-xs font-mono bg-muted rounded-md p-3 overflow-auto max-h-[300px]">
                                {JSON.stringify(strategy.policy, null, 2)}
                            </pre>
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Context</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <pre className="text-sm whitespace-pre-wrap bg-muted rounded-md p-3 overflow-auto max-h-[400px]">
                            {strategy.context || "(empty)"}
                        </pre>
                    </CardContent>
                </Card>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Run History</CardTitle>
                </CardHeader>
                <CardContent>
                    {runs.length === 0 ? (
                        <EmptyState
                            icon={History}
                            title="No runs"
                            description="This strategy has not been run yet"
                        />
                    ) : (
                        <div className="space-y-2">
                            {runs.map((run) => (
                                <div
                                    key={run._id}
                                    className="flex items-center justify-between rounded-lg border border-border-subtle p-3"
                                >
                                    <div className="flex items-center gap-3 min-w-0">
                                        <StatusDot status={run.status} />
                                        <div className="min-w-0">
                                            <p className="text-sm font-medium">
                                                {formatTimestamp(run.startedAt)}
                                            </p>
                                            {run.summary ? (
                                                <p className="text-xs text-muted-foreground truncate max-w-[300px]">
                                                    {run.summary}
                                                </p>
                                            ) : null}
                                            {run.error ? (
                                                <p className="text-xs text-signal-danger truncate max-w-[300px]">
                                                    {run.error}
                                                </p>
                                            ) : null}
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-3 shrink-0">
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
                                        {run.endedAt ? (
                                            <span className="text-xs text-muted-foreground tabular-nums font-mono">
                                                {Math.round((run.endedAt - run.startedAt) / 1000)}s
                                            </span>
                                        ) : null}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    )
}

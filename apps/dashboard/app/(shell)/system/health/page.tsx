"use client"

import { useQuery } from "convex/react"
import { api } from "@valiq-trading/convex"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { StatusDot } from "@/components/status-dot"
import { StatusBadge } from "@/components/status-badge"
import { PageSkeleton } from "@/components/page-skeleton"
import { EmptyState } from "@/components/empty-state"
import { CodexOAuthPanel } from "@/components/codex-oauth-panel"
import { formatRelativeTime } from "@/lib/format"
import { isHeartbeatStale } from "@/lib/heartbeat"
import { Heart } from "lucide-react"

export default function HealthPage() {
    const health = useQuery(api.queries.getAppHealth)

    if (health === undefined) {
        return <PageSkeleton count={4} height="h-20" />
    }

    if (health.length === 0) {
        return (
            <div className="space-y-3">
                <CodexOAuthPanel />
                <EmptyState
                    icon={Heart}
                    title="No heartbeats"
                    description="No apps have reported health status yet"
                />
            </div>
        )
    }

    return (
        <div className="space-y-3">
            <CodexOAuthPanel />
            {health.map((hb) => {
                const isStale = isHeartbeatStale(hb.lastHeartbeat)
                const effectiveStatus = isStale ? "unhealthy" : hb.status

                return (
                    <Card key={hb._id}>
                        <CardContent className="flex items-center justify-between py-4">
                            <div className="flex items-center gap-3">
                                <StatusDot status={effectiveStatus} />
                                <div>
                                    <p className="text-sm font-medium">{hb.app}</p>
                                    <p className="text-xs text-muted-foreground">
                                        Last heartbeat: {formatRelativeTime(hb.lastHeartbeat)}
                                    </p>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                {isStale ? (
                                    <Badge variant="destructive" className="text-xs">stale</Badge>
                                ) : null}
                                <StatusBadge
                                    status={effectiveStatus}
                                    category="health"
                                    fallback="destructive"
                                />
                            </div>
                        </CardContent>
                        {hb.metadata ? (
                            <CardContent className="pt-0">
                                <pre className="text-xs font-mono bg-muted/50 rounded p-2 overflow-auto max-h-[100px]">
                                    {JSON.stringify(hb.metadata, null, 2)}
                                </pre>
                            </CardContent>
                        ) : null}
                    </Card>
                )
            })}
        </div>
    )
}

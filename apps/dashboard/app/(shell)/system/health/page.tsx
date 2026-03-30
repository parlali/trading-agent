"use client"

import { useQuery } from "convex/react"
import { api } from "@valiq-trading/convex"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { StatusDot } from "@/components/status-dot"
import { EmptyState } from "@/components/empty-state"
import { formatRelativeTime } from "@/lib/format"
import { Heart } from "lucide-react"

export default function HealthPage() {
    const health = useQuery(api.queries.getAppHealth)

    if (health === undefined) {
        return (
            <div className="space-y-3">
                {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-20" />
                ))}
            </div>
        )
    }

    if (health.length === 0) {
        return (
            <EmptyState
                icon={Heart}
                title="No heartbeats"
                description="No apps have reported health status yet"
            />
        )
    }

    const now = Date.now()
    const STALE_THRESHOLD_MS = 2 * 60 * 1000

    return (
        <div className="space-y-3">
            {health.map((hb) => {
                const isStale = now - hb.lastHeartbeat > STALE_THRESHOLD_MS
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
                                <Badge
                                    variant={
                                        effectiveStatus === "healthy"
                                            ? "default"
                                            : effectiveStatus === "degraded"
                                                ? "secondary"
                                                : "destructive"
                                    }
                                    className="text-xs"
                                >
                                    {effectiveStatus}
                                </Badge>
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

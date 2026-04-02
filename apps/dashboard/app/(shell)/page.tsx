"use client"

import { useDashboardOverview } from "@/hooks/use-dashboard-overview"
import { isHeartbeatStale } from "@/lib/heartbeat"
import Link from "next/link"
import {
    CheckCircle2,
    ChevronRight,
    Layers,
    Plus,
    Server,
    ShieldAlert,
    XCircle,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { VenueBadge } from "@/components/venue-badge"
import { StatusDot } from "@/components/status-dot"
import { StatusBadge } from "@/components/status-badge"
import { formatRelativeTime } from "@/lib/format"
import { VENUE_META, type VenueApp } from "@/lib/constants"

function OverviewSkeleton() {
    return (
        <div className="space-y-6">
            <Card>
                <CardHeader>
                    <Skeleton className="h-5 w-40" />
                </CardHeader>
                <CardContent className="space-y-3">
                    {Array.from({ length: 4 }).map((_, i) => (
                        <Skeleton key={i} className="h-14 w-full" />
                    ))}
                </CardContent>
            </Card>
            <Card>
                <CardHeader>
                    <Skeleton className="h-5 w-32" />
                </CardHeader>
                <CardContent>
                    <Skeleton className="h-20 w-full" />
                </CardContent>
            </Card>
        </div>
    )
}

type Heartbeat = {
    app: string
    status: string
    lastHeartbeat: number
    metadata?: Record<string, unknown>
}

function DeploymentRow({
    label,
    description,
    heartbeat,
}: {
    label: string
    description: string
    heartbeat: Heartbeat | undefined
}) {
    const hasHeartbeat = !!heartbeat
    const stale = hasHeartbeat && isHeartbeatStale(heartbeat.lastHeartbeat)
    const effectiveStatus = !hasHeartbeat
        ? "unreachable"
        : stale
            ? "stale"
            : heartbeat.status

    return (
        <div className="flex items-center justify-between rounded-lg border border-border-subtle p-3 sm:p-4">
            <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
                {effectiveStatus === "healthy" ? (
                    <CheckCircle2 className="h-4 w-4 text-signal-healthy shrink-0" />
                ) : effectiveStatus === "stale" ? (
                    <XCircle className="h-4 w-4 text-signal-warning shrink-0" />
                ) : (
                    <XCircle className="h-4 w-4 text-signal-danger shrink-0" />
                )}
                <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{label}</p>
                    <p className="text-xs text-muted-foreground hidden sm:block">{description}</p>
                </div>
            </div>
            <div className="text-right shrink-0 ml-2">
                {hasHeartbeat ? (
                    <>
                        <StatusBadge
                            status={effectiveStatus}
                            category="health"
                            fallback="destructive"
                        >
                            {stale ? "stale" : heartbeat.status}
                        </StatusBadge>
                        <p className="text-xs text-muted-foreground mt-1">
                            {formatRelativeTime(heartbeat.lastHeartbeat)}
                        </p>
                    </>
                ) : (
                    <Badge variant="outline" className="text-xs text-muted-foreground">
                        no heartbeat
                    </Badge>
                )}
            </div>
        </div>
    )
}

function StrategyRow({ strategy }: {
    strategy: {
        _id: string
        name: string
        app: string
        enabled: boolean
        latestRun?: { status: string, startedAt: number } | null
    }
}) {
    return (
        <Link
            href={`/strategies/${strategy._id}`}
            className="flex items-center justify-between rounded-lg border border-border-subtle p-3 transition-colors hover:bg-muted/50 hover:border-border group"
        >
            <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
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
                    <p className="text-sm font-medium truncate">{strategy.name}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                        <VenueBadge app={strategy.app} />
                        {!strategy.enabled ? (
                            <Badge variant="secondary" className="text-xs">disabled</Badge>
                        ) : null}
                    </div>
                </div>
            </div>
            <div className="flex items-center gap-2 shrink-0 ml-2">
                {strategy.latestRun ? (
                    <div className="text-right">
                        <StatusBadge
                            status={strategy.latestRun.status}
                            category="run"
                        />
                        <p className="text-xs text-muted-foreground mt-1">
                            {formatRelativeTime(strategy.latestRun.startedAt)}
                        </p>
                    </div>
                ) : (
                    <span className="text-xs text-muted-foreground">never run</span>
                )}
                <ChevronRight className="h-4 w-4 text-muted-foreground/50 group-hover:text-muted-foreground transition-colors" />
            </div>
        </Link>
    )
}

export default function OverviewPage() {
    const { data, isLoading } = useDashboardOverview()

    if (isLoading || !data) return <OverviewSkeleton />

    const isGlobalKilled = data.systemState.globalKillSwitch
    const killSwitches = data.systemState.appKillSwitches ?? {}

    const backendHeartbeat = data.appHealth.find((h) => h.app === "backend") as Heartbeat | undefined
    const venueHeartbeats = (["alpaca-options", "polymarket", "mt5"] as const).map((app) => ({
        app,
        heartbeat: data.appHealth.find((h) => h.app === app) as Heartbeat | undefined,
    }))

    const healthyCount = venueHeartbeats.filter(
        (v) => v.heartbeat && !isHeartbeatStale(v.heartbeat.lastHeartbeat) && v.heartbeat.status === "healthy",
    ).length

    const strategyCount = data.strategies.length
    const enabledCount = data.strategies.filter((s) => s.enabled).length

    return (
        <div className="space-y-6">
            {isGlobalKilled ? (
                <div className="flex items-center gap-2 rounded-lg border border-signal-danger/30 bg-signal-danger/10 px-4 py-3">
                    <ShieldAlert className="h-4 w-4 text-signal-danger shrink-0" />
                    <span className="text-sm font-medium text-signal-danger">
                        Global kill switch is active -- all trading is halted
                    </span>
                </div>
            ) : null}

            <Card>
                <CardHeader>
                    <div className="flex items-center justify-between">
                        <CardTitle className="text-base flex items-center gap-2">
                            <Server className="h-4 w-4" />
                            Deployment Status
                        </CardTitle>
                        <span className="text-xs text-muted-foreground">
                            {healthyCount}/3 venues connected
                        </span>
                    </div>
                </CardHeader>
                <CardContent className="space-y-2 sm:space-y-3">
                    <DeploymentRow
                        label="Backend"
                        description="Strategy scheduler and execution runtime"
                        heartbeat={backendHeartbeat}
                    />
                    {venueHeartbeats.map(({ app, heartbeat }) => {
                        const meta = VENUE_META[app]
                        const killed = killSwitches[app.replace("-", "_") as keyof typeof killSwitches]
                        return (
                            <div key={app} className="relative">
                                <DeploymentRow
                                    label={meta.label}
                                    description={meta.description}
                                    heartbeat={heartbeat}
                                />
                                {killed ? (
                                    <Badge
                                        variant="destructive"
                                        className="absolute top-2 right-2 text-xs"
                                    >
                                        killed
                                    </Badge>
                                ) : null}
                            </div>
                        )
                    })}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                        <CardTitle className="text-base flex items-center gap-2">
                            <Layers className="h-4 w-4" />
                            Strategies
                        </CardTitle>
                        <div className="flex items-center gap-2 sm:gap-3">
                            <span className="text-xs text-muted-foreground">
                                {enabledCount}/{strategyCount}
                            </span>
                            <Button size="xs" variant="outline" asChild>
                                <Link href="/strategies/new">
                                    <Plus className="h-3 w-3" />
                                    <span className="hidden sm:inline">New</span>
                                </Link>
                            </Button>
                        </div>
                    </div>
                </CardHeader>
                <CardContent>
                    {strategyCount === 0 ? (
                        <p className="text-sm text-muted-foreground py-4 text-center">
                            No strategies configured yet
                        </p>
                    ) : (
                        <div className="space-y-2">
                            {data.strategies.map((strategy) => (
                                <StrategyRow key={strategy._id} strategy={strategy} />
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    )
}

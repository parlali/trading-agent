"use client"

import { useQuery } from "convex/react"
import { api } from "@valiq-trading/convex"
import {
    AlertTriangle,
    DollarSign,
    Layers,
    Play,
    ShieldAlert,
    Wallet,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { VenueBadge } from "@/components/venue-badge"
import { StatusDot } from "@/components/status-dot"
import { PnlText } from "@/components/pnl-text"
import { EmptyState } from "@/components/empty-state"
import { formatCurrency, formatRelativeTime } from "@/lib/format"
import { VENUE_META, SEVERITY_COLORS, type VenueApp } from "@/lib/constants"

function MetricCard({
    label,
    value,
    icon: Icon,
    subtitle,
}: {
    label: string
    value: string | React.ReactNode
    icon: typeof DollarSign
    subtitle?: string
}) {
    return (
        <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
                <Icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
                <div className="text-2xl font-semibold tabular-nums font-mono">{value}</div>
                {subtitle ? (
                    <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
                ) : null}
            </CardContent>
        </Card>
    )
}

function OverviewSkeleton() {
    return (
        <div className="space-y-6">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {Array.from({ length: 4 }).map((_, i) => (
                    <Card key={i}>
                        <CardHeader className="pb-2">
                            <Skeleton className="h-4 w-24" />
                        </CardHeader>
                        <CardContent>
                            <Skeleton className="h-8 w-32" />
                        </CardContent>
                    </Card>
                ))}
            </div>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {Array.from({ length: 4 }).map((_, i) => (
                    <Card key={i}>
                        <CardHeader>
                            <Skeleton className="h-5 w-32" />
                        </CardHeader>
                        <CardContent>
                            <Skeleton className="h-24 w-full" />
                        </CardContent>
                    </Card>
                ))}
            </div>
        </div>
    )
}

export default function OverviewPage() {
    const data = useQuery(api.queries.getDashboardOverview)

    if (data === undefined) return <OverviewSkeleton />

    const totalEquity = data.accountSnapshots.reduce(
        (sum, s) => sum + s.balance + s.openPnl,
        0,
    )

    const totalOpenPnl = data.accountSnapshots.reduce(
        (sum, s) => sum + s.openPnl,
        0,
    )

    const positionCount = data.openPositions.length
    const activeRunCount = data.activeRuns.length
    const criticalAlerts = data.recentAlerts.filter(
        (a) => a.severity === "critical" && !a.acknowledged,
    )

    const isGlobalKilled = data.systemState.globalKillSwitch

    return (
        <div className="space-y-6">
            {isGlobalKilled ? (
                <div className="flex items-center gap-2 rounded-lg border border-signal-danger/30 bg-signal-danger/10 px-4 py-3">
                    <ShieldAlert className="h-4 w-4 text-signal-danger" />
                    <span className="text-sm font-medium text-signal-danger">
                        Global kill switch is active -- all trading is halted
                    </span>
                </div>
            ) : null}

            {criticalAlerts.length > 0 ? (
                <div className="flex items-center gap-2 rounded-lg border border-signal-danger/30 bg-signal-danger/10 px-4 py-3">
                    <AlertTriangle className="h-4 w-4 text-signal-danger" />
                    <span className="text-sm font-medium text-signal-danger">
                        {criticalAlerts.length} unacknowledged critical alert{criticalAlerts.length > 1 ? "s" : ""}
                    </span>
                </div>
            ) : null}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <MetricCard
                    label="Total Equity"
                    value={formatCurrency(totalEquity)}
                    icon={Wallet}
                    subtitle={`Across ${data.accountSnapshots.length} venue${data.accountSnapshots.length !== 1 ? "s" : ""}`}
                />
                <MetricCard
                    label="Open P&L"
                    value={<PnlText value={totalOpenPnl} />}
                    icon={DollarSign}
                />
                <MetricCard
                    label="Open Positions"
                    value={String(positionCount)}
                    icon={Layers}
                    subtitle={`${data.strategies.filter((s) => s.enabled).length} active strategies`}
                />
                <MetricCard
                    label="Active Runs"
                    value={String(activeRunCount)}
                    icon={Play}
                />
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Venue Accounts</CardTitle>
                    </CardHeader>
                    <CardContent>
                        {data.accountSnapshots.length === 0 ? (
                            <p className="text-sm text-muted-foreground">No account snapshots yet</p>
                        ) : (
                            <div className="space-y-3">
                                {data.accountSnapshots.map((snapshot) => {
                                    const meta = VENUE_META[snapshot.app as VenueApp]
                                    const heartbeat = data.appHealth.find((h) => h.app === snapshot.app)
                                    return (
                                        <div
                                            key={snapshot._id}
                                            className="flex items-center justify-between rounded-lg border border-border-subtle p-3"
                                        >
                                            <div className="flex items-center gap-3">
                                                {heartbeat ? (
                                                    <StatusDot status={heartbeat.status} />
                                                ) : (
                                                    <StatusDot status="unhealthy" />
                                                )}
                                                <div>
                                                    <p className="text-sm font-medium">
                                                        {meta?.shortLabel ?? snapshot.app}
                                                    </p>
                                                    <p className="text-xs text-muted-foreground">
                                                        {formatRelativeTime(snapshot.timestamp)}
                                                    </p>
                                                </div>
                                            </div>
                                            <div className="text-right">
                                                <p className="text-sm font-mono tabular-nums">
                                                    {formatCurrency(snapshot.balance)}
                                                </p>
                                                <PnlText value={snapshot.openPnl} className="text-xs" />
                                            </div>
                                        </div>
                                    )
                                })}
                            </div>
                        )}
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Strategies</CardTitle>
                    </CardHeader>
                    <CardContent>
                        {data.strategies.length === 0 ? (
                            <EmptyState
                                icon={Layers}
                                title="No strategies"
                                description="Create a strategy to get started"
                            />
                        ) : (
                            <div className="space-y-2">
                                {data.strategies.map((strategy) => (
                                    <div
                                        key={strategy._id}
                                        className="flex items-center justify-between rounded-lg border border-border-subtle p-3"
                                    >
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
                                                <p className="text-sm font-medium truncate">{strategy.name}</p>
                                                <div className="flex items-center gap-2 mt-0.5">
                                                    <VenueBadge app={strategy.app} />
                                                    {!strategy.enabled ? (
                                                        <Badge variant="secondary" className="text-xs">disabled</Badge>
                                                    ) : null}
                                                </div>
                                            </div>
                                        </div>
                                        {strategy.latestRun ? (
                                            <div className="text-right shrink-0">
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
                                    </div>
                                ))}
                            </div>
                        )}
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Recent Runs</CardTitle>
                    </CardHeader>
                    <CardContent>
                        {data.recentRuns.length === 0 ? (
                            <EmptyState
                                icon={Play}
                                title="No runs yet"
                                description="Strategy runs will appear here"
                            />
                        ) : (
                            <div className="space-y-2">
                                {data.recentRuns.slice(0, 8).map((run) => {
                                    const strategy = data.strategies.find(
                                        (s) => String(s._id) === String(run.strategyId),
                                    )
                                    return (
                                        <div
                                            key={run._id}
                                            className="flex items-center justify-between text-sm"
                                        >
                                            <div className="flex items-center gap-2 min-w-0">
                                                <StatusDot status={run.status} />
                                                <span className="truncate">
                                                    {strategy?.name ?? "Unknown"}
                                                </span>
                                            </div>
                                            <span className="text-xs text-muted-foreground shrink-0">
                                                {formatRelativeTime(run.startedAt)}
                                            </span>
                                        </div>
                                    )
                                })}
                            </div>
                        )}
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Recent Alerts</CardTitle>
                    </CardHeader>
                    <CardContent>
                        {data.recentAlerts.length === 0 ? (
                            <EmptyState
                                icon={AlertTriangle}
                                title="No alerts"
                                description="System alerts will appear here"
                            />
                        ) : (
                            <div className="space-y-2">
                                {data.recentAlerts.slice(0, 8).map((alert) => (
                                    <div
                                        key={alert._id}
                                        className="flex items-start gap-2 text-sm"
                                    >
                                        <Badge
                                            variant="outline"
                                            className={`text-xs shrink-0 ${SEVERITY_COLORS[alert.severity as keyof typeof SEVERITY_COLORS] ?? ""}`}
                                        >
                                            {alert.severity}
                                        </Badge>
                                        <span className="text-muted-foreground truncate flex-1">
                                            {alert.message}
                                        </span>
                                        <span className="text-xs text-muted-foreground/60 shrink-0">
                                            {formatRelativeTime(alert.timestamp)}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </CardContent>
                </Card>
            </div>

            {data.openPositions.length > 0 ? (
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">
                            Open Positions ({data.openPositions.length})
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b text-left text-muted-foreground">
                                        <th className="pb-2 pr-4 font-medium">Venue</th>
                                        <th className="pb-2 pr-4 font-medium">Strategy</th>
                                        <th className="pb-2 pr-4 font-medium">Instrument</th>
                                        <th className="pb-2 pr-4 font-medium">Side</th>
                                        <th className="pb-2 pr-4 font-medium text-right">Qty</th>
                                        <th className="pb-2 pr-4 font-medium text-right">Entry</th>
                                        <th className="pb-2 font-medium text-right">Unrealized P&L</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {data.openPositions.map((pos, i) => (
                                        <tr key={i} className="border-b border-border-subtle last:border-0">
                                            <td className="py-2 pr-4">
                                                <VenueBadge app={pos.app} />
                                            </td>
                                            <td className="py-2 pr-4 truncate max-w-[120px]">
                                                {pos.strategy?.name ?? "Unknown"}
                                            </td>
                                            <td className="py-2 pr-4 font-mono text-xs">
                                                {pos.instrument}
                                            </td>
                                            <td className="py-2 pr-4">
                                                <Badge variant={pos.side === "long" ? "default" : "destructive"} className="text-xs">
                                                    {pos.side}
                                                </Badge>
                                            </td>
                                            <td className="py-2 pr-4 text-right font-mono tabular-nums">
                                                {pos.quantity}
                                            </td>
                                            <td className="py-2 pr-4 text-right font-mono tabular-nums">
                                                {formatCurrency(pos.entryPrice)}
                                            </td>
                                            <td className="py-2 text-right">
                                                <PnlText value={pos.unrealizedPnl ?? 0} className="text-xs" />
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </CardContent>
                </Card>
            ) : null}
        </div>
    )
}

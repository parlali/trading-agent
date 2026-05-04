"use client"

import { use } from "react"
import { useDashboardOverview } from "@/hooks/use-dashboard-overview"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { StatusDot } from "@/components/status-dot"
import { PnlText } from "@/components/pnl-text"
import { StatCard } from "@/components/stat-card"
import { StatusBadge } from "@/components/status-badge"
import { PageSkeleton } from "@/components/page-skeleton"
import { EmptyState } from "@/components/empty-state"
import { formatCurrency, formatRelativeTime } from "@/lib/format"
import { VENUE_META, type VenueApp } from "@/lib/constants"
import { Layers, Play } from "lucide-react"
import { toVenueKillSwitchKey } from "@valiq-trading/core"

export default function VenuePage({
    params,
}: {
    params: Promise<{ app: string }>
}) {
    const { app } = use(params)
    const meta = VENUE_META[app as VenueApp]
    const { data: overview, isLoading } = useDashboardOverview()

    if (isLoading || !overview) {
        return (
            <div className="space-y-6">
                <Skeleton className="h-8 w-48" />
                <PageSkeleton count={3} height="h-32" />
            </div>
        )
    }

    const snapshot = overview.accountSnapshots.find((s) => s.app === app)
    const heartbeat = overview.appHealth.find((h) => h.app === app)
    const venueStrategies = overview.strategies.filter((s) => s.app === app)
    const venuePositions = overview.openPositions.filter((p) => p.app === app)
    const venueRuns = overview.recentRuns.filter((r) => r.app === app)
    const killSwitchKey = toVenueKillSwitchKey(app as VenueApp)
    const isKilled = overview.systemState.appKillSwitches[killSwitchKey] === true

    return (
        <div className="space-y-6">
            <div className="flex items-center gap-3">
                {meta ? <meta.icon className="h-5 w-5 text-muted-foreground" /> : null}
                <div>
                    <h2 className="text-lg font-semibold">{meta?.label ?? app}</h2>
                    <p className="text-sm text-muted-foreground">{meta?.description ?? ""}</p>
                </div>
                {heartbeat ? (
                    <div className="ml-auto flex items-center gap-2">
                        <StatusDot status={heartbeat.status} />
                        <span className="text-sm text-muted-foreground">{heartbeat.status}</span>
                    </div>
                ) : null}
            </div>

            {isKilled ? (
                <div className="flex items-center gap-2 rounded-lg border border-signal-danger/30 bg-signal-danger/10 px-4 py-3">
                    <span className="text-sm font-medium text-signal-danger">
                        Kill switch active for {meta?.shortLabel ?? app}
                    </span>
                </div>
            ) : null}

            {snapshot ? (
                <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
                    <StatCard label="Balance" value={snapshot.balance} format="currency" />
                    <StatCard label="Buying Power" value={snapshot.buyingPower} format="currency" />
                    <StatCard label="Open P&L" value={snapshot.openPnl} format="pnl" />
                    <StatCard label="Day P&L" value={snapshot.dayPnl} format="pnl" />
                </div>
            ) : (
                <Card>
                    <CardContent className="py-6">
                        <p className="text-sm text-muted-foreground">No account snapshot available</p>
                    </CardContent>
                </Card>
            )}

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">
                            Strategies ({venueStrategies.length})
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        {venueStrategies.length === 0 ? (
                            <EmptyState
                                icon={Layers}
                                title="No strategies"
                                description={`No strategies configured for ${meta?.shortLabel ?? app}`}
                            />
                        ) : (
                            <div className="space-y-2">
                                {venueStrategies.map((strategy) => (
                                    <div
                                        key={strategy._id}
                                        className="flex items-center justify-between rounded-lg border border-border-subtle p-3"
                                    >
                                        <div className="flex items-center gap-2">
                                            <StatusDot
                                                status={strategy.enabled ? "healthy" : "unhealthy"}
                                            />
                                            <span className="text-sm font-medium">{strategy.name}</span>
                                            {!strategy.enabled ? (
                                                <Badge variant="secondary" className="text-xs">disabled</Badge>
                                            ) : null}
                                        </div>
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
                                        ) : null}
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
                        {venueRuns.length === 0 ? (
                            <EmptyState
                                icon={Play}
                                title="No runs"
                                description="No recent runs for this venue"
                            />
                        ) : (
                            <div className="space-y-2">
                                {venueRuns.map((run) => {
                                    const strategy = venueStrategies.find(
                                        (s) => String(s._id) === String(run.strategyId),
                                    )
                                    return (
                                        <div
                                            key={run._id}
                                            className="flex items-center justify-between text-sm"
                                        >
                                            <div className="flex items-center gap-2">
                                                <StatusDot status={run.status} />
                                                <span>{strategy?.name ?? "Unknown"}</span>
                                            </div>
                                            <span className="text-xs text-muted-foreground">
                                                {formatRelativeTime(run.startedAt)}
                                            </span>
                                        </div>
                                    )
                                })}
                            </div>
                        )}
                    </CardContent>
                </Card>
            </div>

            {venuePositions.length > 0 ? (
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">
                            Open Positions ({venuePositions.length})
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b text-left text-muted-foreground">
                                        <th className="pb-2 pr-4 font-medium">Instrument</th>
                                        <th className="pb-2 pr-4 font-medium">Side</th>
                                        <th className="pb-2 pr-4 font-medium text-right">Qty</th>
                                        <th className="pb-2 pr-4 font-medium text-right">Entry</th>
                                        <th className="pb-2 pr-4 font-medium text-right">Current</th>
                                        <th className="pb-2 font-medium text-right">P&L</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {venuePositions.map((pos, i) => (
                                        <tr key={i} className="border-b border-border-subtle last:border-0">
                                            <td className="py-2 pr-4 font-mono text-xs">{pos.instrument}</td>
                                            <td className="py-2 pr-4">
                                                <Badge variant={pos.side === "long" ? "default" : "destructive"} className="text-xs">
                                                    {pos.side}
                                                </Badge>
                                            </td>
                                            <td className="py-2 pr-4 text-right font-mono tabular-nums">{pos.quantity}</td>
                                            <td className="py-2 pr-4 text-right font-mono tabular-nums">{formatCurrency(pos.entryPrice)}</td>
                                            <td className="py-2 pr-4 text-right font-mono tabular-nums">
                                                {pos.currentPrice ? formatCurrency(pos.currentPrice) : "--"}
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

"use client"

import { useState } from "react"
import { useDashboardOverview } from "@/hooks/use-dashboard-overview"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { PageSkeleton } from "@/components/page-skeleton"
import { VenueBadge } from "@/components/venue-badge"
import { PnlText } from "@/components/pnl-text"
import { EmptyState } from "@/components/empty-state"
import { FilterBar } from "@/components/filter-bar"
import { formatCurrency } from "@/lib/format"
import { VENUE_APPS, VENUE_META, type VenueApp } from "@/lib/constants"
import { Activity } from "lucide-react"

type PositionItem = {
    app: VenueApp
    instrument: string
    side: string
    quantity: number
    entryPrice: number
    currentPrice?: number | null
    unrealizedPnl?: number | null
    strategy?: {
        _id?: string
        name: string
    } | null
}

type PositionGroupBy = "none" | "venue" | "strategy"

type PositionGroup = {
    key: string
    title: string
    app?: VenueApp
    positions: PositionItem[]
}

const GROUP_BY_OPTIONS = ["none", "venue", "strategy"] as const satisfies readonly PositionGroupBy[]

function getPositionKey(pos: PositionItem) {
    return [
        pos.app,
        pos.strategy?._id ?? pos.strategy?.name ?? "unknown",
        pos.instrument,
        pos.side,
        pos.quantity,
        pos.entryPrice,
    ].join(":")
}

function getGroupTotalUnrealizedPnl(positions: PositionItem[]) {
    return positions.reduce((sum, pos) => sum + (pos.unrealizedPnl ?? 0), 0)
}

function groupPositions(positions: PositionItem[], groupBy: PositionGroupBy): PositionGroup[] {
    if (groupBy === "none") {
        return [{
            key: "all",
            title: "All positions",
            positions,
        }]
    }

    const groups = new Map<string, PositionGroup>()

    for (const pos of positions) {
        const strategyId = pos.strategy?._id ?? `${pos.app}:${pos.strategy?.name ?? "unknown"}`
        const groupKey = groupBy === "venue" ? pos.app : strategyId
        const existing = groups.get(groupKey)

        if (existing) {
            existing.positions.push(pos)
            continue
        }

        groups.set(groupKey, {
            key: groupKey,
            title: groupBy === "venue"
                ? VENUE_META[pos.app]?.label ?? pos.app
                : pos.strategy?.name ?? "Unknown strategy",
            app: pos.app,
            positions: [pos],
        })
    }

    const grouped = Array.from(groups.values())

    if (groupBy === "venue") {
        return grouped.sort(
            (a, b) => VENUE_APPS.indexOf(a.key as VenueApp) - VENUE_APPS.indexOf(b.key as VenueApp),
        )
    }

    return grouped.sort((a, b) => a.title.localeCompare(b.title))
}

function PositionCard({ pos }: { pos: PositionItem }) {
    return (
        <div className="rounded-lg border border-border-subtle p-3 space-y-2">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-medium font-mono truncate">{pos.instrument}</span>
                    <Badge
                        variant={pos.side === "long" ? "default" : "destructive"}
                        className="text-xs shrink-0"
                    >
                        {pos.side}
                    </Badge>
                </div>
                <PnlText value={pos.unrealizedPnl ?? 0} className="text-sm font-medium shrink-0" />
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
                <div className="flex items-center gap-2">
                    <VenueBadge app={pos.app} />
                    <span className="truncate max-w-[100px]">{pos.strategy?.name ?? "Unknown"}</span>
                </div>
                <div className="flex items-center gap-3 font-mono tabular-nums shrink-0">
                    <span>qty {pos.quantity}</span>
                    <span>{formatCurrency(pos.entryPrice)}</span>
                </div>
            </div>
        </div>
    )
}

function PositionTable({ positions }: { positions: PositionItem[] }) {
    return (
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
                        <th className="pb-2 pr-4 font-medium text-right">Current</th>
                        <th className="pb-2 font-medium text-right">P&L</th>
                    </tr>
                </thead>
                <tbody>
                    {positions.map((pos) => (
                        <tr key={getPositionKey(pos)} className="border-b border-border-subtle last:border-0">
                            <td className="py-2 pr-4">
                                <VenueBadge app={pos.app} />
                            </td>
                            <td className="py-2 pr-4 truncate max-w-[120px]">
                                {pos.strategy?.name ?? "Unknown"}
                            </td>
                            <td className="py-2 pr-4 font-mono text-xs">{pos.instrument}</td>
                            <td className="py-2 pr-4">
                                <Badge
                                    variant={pos.side === "long" ? "default" : "destructive"}
                                    className="text-xs"
                                >
                                    {pos.side}
                                </Badge>
                            </td>
                            <td className="py-2 pr-4 text-right font-mono tabular-nums">
                                {pos.quantity}
                            </td>
                            <td className="py-2 pr-4 text-right font-mono tabular-nums">
                                {formatCurrency(pos.entryPrice)}
                            </td>
                            <td className="py-2 pr-4 text-right font-mono tabular-nums">
                                {pos.currentPrice != null ? formatCurrency(pos.currentPrice) : "--"}
                            </td>
                            <td className="py-2 text-right">
                                <PnlText value={pos.unrealizedPnl ?? 0} className="text-xs" />
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

function PositionGroupSection({
    group,
    groupBy,
}: {
    group: PositionGroup
    groupBy: PositionGroupBy
}) {
    const groupTotalUnrealizedPnl = getGroupTotalUnrealizedPnl(group.positions)

    return (
        <section className="space-y-3">
            {groupBy !== "none" ? (
                <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                        {groupBy === "venue" && group.app ? <VenueBadge app={group.app} /> : null}
                        <div className="min-w-0">
                            <h3 className="truncate text-sm font-semibold">{group.title}</h3>
                            <p className="text-xs text-muted-foreground">
                                {group.positions.length} position{group.positions.length !== 1 ? "s" : ""}
                            </p>
                        </div>
                    </div>
                    <PnlText value={groupTotalUnrealizedPnl} className="text-sm font-semibold shrink-0" />
                </div>
            ) : null}

            <div className="space-y-2 sm:hidden">
                {group.positions.map((pos) => (
                    <PositionCard key={getPositionKey(pos)} pos={pos} />
                ))}
            </div>

            <Card className="hidden sm:block">
                {groupBy !== "none" ? (
                    <CardHeader className="pb-3">
                        <CardTitle className="text-base">{group.title}</CardTitle>
                    </CardHeader>
                ) : null}
                <CardContent className={groupBy === "none" ? "pt-6" : "pt-0"}>
                    <PositionTable positions={group.positions} />
                </CardContent>
            </Card>
        </section>
    )
}

export default function PositionsPage() {
    const [groupBy, setGroupBy] = useState<PositionGroupBy>("none")
    const { data: overview, isLoading } = useDashboardOverview()

    if (isLoading || !overview) {
        return <PageSkeleton count={1} height="h-64" />
    }

    const positions = overview.openPositions as PositionItem[]

    if (positions.length === 0) {
        return (
            <EmptyState
                icon={Activity}
                title="No open positions"
                description="Open positions across all venues will appear here"
            />
        )
    }

    const totalUnrealizedPnl = positions.reduce(
        (sum, p) => sum + (p.unrealizedPnl ?? 0),
        0,
    )
    const groupedPositions = groupPositions(positions, groupBy)

    return (
        <div className="space-y-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex items-center justify-between gap-3">
                    <p className="text-sm text-muted-foreground">
                        {positions.length} open position{positions.length !== 1 ? "s" : ""}
                    </p>
                    <div className="flex items-center gap-2 text-sm">
                        <span className="text-muted-foreground">Total P&L:</span>
                        <PnlText value={totalUnrealizedPnl} className="font-semibold" />
                    </div>
                </div>
                <div className="flex items-center justify-between gap-3 lg:justify-end">
                    <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Group by
                    </span>
                    <FilterBar
                        items={GROUP_BY_OPTIONS}
                        selected={groupBy}
                        onSelect={setGroupBy}
                        getLabel={(value) => {
                            if (value === "none") return "None"
                            if (value === "venue") return "Venue"
                            return "Strategy"
                        }}
                        variant="tabs"
                    />
                </div>
            </div>

            <div className="space-y-4">
                {groupedPositions.map((group) => (
                    <PositionGroupSection key={group.key} group={group} groupBy={groupBy} />
                ))}
            </div>
        </div>
    )
}

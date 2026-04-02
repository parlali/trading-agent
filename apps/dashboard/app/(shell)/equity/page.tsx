"use client"

import { useState, useMemo } from "react"
import { useQuery } from "convex/react"
import { api } from "@valiq-trading/convex"
import {
    AreaChart,
    Area,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip as RechartsTooltip,
    ResponsiveContainer,
    Legend,
} from "recharts"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { PnlText } from "@/components/pnl-text"
import { StatCard } from "@/components/stat-card"
import { FilterBar } from "@/components/filter-bar"
import { formatCurrency, formatCompactCurrency, formatTimestamp } from "@/lib/format"
import { VENUE_META, VENUE_APPS, type VenueApp } from "@/lib/constants"

type TimeRange = "24h" | "7d" | "30d" | "90d" | "all"

const TIME_RANGES: { value: TimeRange, label: string }[] = [
    { value: "24h", label: "24H" },
    { value: "7d", label: "7D" },
    { value: "30d", label: "30D" },
    { value: "90d", label: "90D" },
    { value: "all", label: "All" },
]

function bucketTimestamp(ts: number, range: TimeRange): number {
    const date = new Date(ts)
    if (range === "24h") {
        date.setMinutes(0, 0, 0)
        return date.getTime()
    }
    date.setHours(0, 0, 0, 0)
    return date.getTime()
}

function formatXAxis(ts: number, range: TimeRange): string {
    const date = new Date(ts)
    if (range === "24h") {
        return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    }
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

export default function EquityPage() {
    const [timeRange, setTimeRange] = useState<TimeRange>("30d")
    const rawData = useQuery(api.queries.getEquityTimeSeries, { timeRange })
    const pnlSummary = useQuery(
        api.queries.getPnlSummary,
        timeRange === "90d" || timeRange === "all"
            ? { timeRange: "30d" }
            : { timeRange },
    )

    const chartData = useMemo(() => {
        if (!rawData || rawData.length === 0) return []

        const bucketMap = new Map<number, Record<string, number>>()

        for (const point of rawData) {
            const bucket = bucketTimestamp(point.timestamp, timeRange)
            const existing = bucketMap.get(bucket) ?? { timestamp: bucket }
            existing[point.app] = point.equity
            bucketMap.set(bucket, existing)
        }

        const sorted = Array.from(bucketMap.values()).sort(
            (a, b) => (a.timestamp as number) - (b.timestamp as number),
        )

        return sorted.map((row) => {
            let total = 0
            for (const app of VENUE_APPS) {
                if (typeof row[app] === "number") {
                    total += row[app]
                }
            }
            return { ...row, total }
        })
    }, [rawData, timeRange])

    if (rawData === undefined) {
        return (
            <div className="space-y-6">
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-[400px] w-full" />
            </div>
        )
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <h2 className="text-lg font-semibold">Total Equity Over Time</h2>
                    <p className="text-sm text-muted-foreground">
                        Combined equity across all venue accounts
                    </p>
                </div>
                <FilterBar
                    items={TIME_RANGES.map((r) => r.value)}
                    selected={timeRange}
                    onSelect={setTimeRange}
                    getLabel={(v) => TIME_RANGES.find((r) => r.value === v)!.label}
                    variant="tabs"
                />
            </div>

            {pnlSummary ? (
                <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
                    <StatCard
                        label="Total Equity"
                        value={pnlSummary.aggregate.latestNetLiq}
                        format="currency"
                        size="2xl"
                    />
                    <StatCard
                        label="Period Change"
                        value={pnlSummary.aggregate.periodChange}
                        format="pnl"
                        size="2xl"
                    />
                    {pnlSummary.apps
                        .filter((a) => a.latest !== null)
                        .map((appData) => {
                            const meta = VENUE_META[appData.app as VenueApp]
                            return (
                                <StatCard
                                    key={appData.app}
                                    label={meta?.shortLabel ?? appData.app}
                                    value={(appData.latest?.balance ?? 0) + (appData.latest?.openPnl ?? 0)}
                                    format="currency"
                                    size="lg"
                                >
                                    <p className="text-lg font-semibold tabular-nums font-mono">
                                        {formatCurrency(
                                            (appData.latest?.balance ?? 0) + (appData.latest?.openPnl ?? 0),
                                        )}
                                    </p>
                                    <PnlText value={appData.change} className="text-xs" />
                                </StatCard>
                            )
                        })}
                </div>
            ) : null}

            <Card>
                <CardContent className="pt-6">
                    {chartData.length === 0 ? (
                        <div className="flex h-[400px] items-center justify-center text-sm text-muted-foreground">
                            No equity data available for this time range
                        </div>
                    ) : (
                        <ResponsiveContainer width="100%" height={400}>
                            <AreaChart data={chartData}>
                                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                                <XAxis
                                    dataKey="timestamp"
                                    tickFormatter={(ts) => formatXAxis(ts, timeRange)}
                                    className="text-xs"
                                    tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                                />
                                <YAxis
                                    tickFormatter={(v) => formatCompactCurrency(v)}
                                    className="text-xs"
                                    tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                                    width={60}
                                />
                                <RechartsTooltip
                                    contentStyle={{
                                        backgroundColor: "var(--card)",
                                        border: "1px solid var(--border)",
                                        borderRadius: "var(--radius)",
                                        fontSize: "12px",
                                    }}
                                    labelFormatter={(ts) => formatTimestamp(ts)}
                                    formatter={(value: number) => [formatCurrency(value)]}
                                />
                                <Legend />
                                {VENUE_APPS.map((app) => {
                                    const meta = VENUE_META[app]
                                    return (
                                        <Area
                                            key={app}
                                            type="monotone"
                                            dataKey={app}
                                            name={meta.shortLabel}
                                            stroke={meta.chartColor}
                                            fill={meta.chartColor}
                                            fillOpacity={0.1}
                                            strokeWidth={1.5}
                                            dot={false}
                                            connectNulls
                                        />
                                    )
                                })}
                                <Area
                                    type="monotone"
                                    dataKey="total"
                                    name="Total"
                                    stroke="var(--foreground)"
                                    fill="var(--foreground)"
                                    fillOpacity={0.05}
                                    strokeWidth={2}
                                    dot={false}
                                    connectNulls
                                />
                            </AreaChart>
                        </ResponsiveContainer>
                    )}
                </CardContent>
            </Card>
        </div>
    )
}

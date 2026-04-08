"use client"

import { useMemo, useState } from "react"
import { useQuery } from "convex/react"
import { api } from "@valiq-trading/convex"
import {
    EquityChart,
    FreshnessHeader,
    PortfolioSection,
    ProviderFilter,
    TIME_RANGES,
    type TimeRange,
} from "@/components/portfolio"
import { Skeleton } from "@/components/ui/skeleton"
import { PnlText } from "@/components/pnl-text"
import { StatCard } from "@/components/stat-card"
import { FilterBar } from "@/components/filter-bar"
import { formatCurrency } from "@/lib/format"
import { VENUE_APPS, VENUE_META } from "@/lib/constants"
import { usePortfolioFreshness } from "@/hooks/use-portfolio-freshness"
import { useProviderFilter } from "@/hooks/use-provider-filter"

export default function EquityPage() {
    const { provider, setProvider } = useProviderFilter()
    const freshnessStates = usePortfolioFreshness(provider)
    const [timeRange, setTimeRange] = useState<TimeRange>("30d")
    const equityData = useQuery(api.queries.getPortfolioEquitySeries, {
        app: provider ?? undefined,
        timeRange,
    })

    const chartData = useMemo(() => {
        if (!equityData) {
            return []
        }

        return equityData.series.map((point) => ({
            timestamp: point.timestamp,
            total: point.total,
            ...point.providers,
        }))
    }, [equityData])

    const providerStats = useMemo(() => {
        if (!equityData?.latest) {
            return []
        }

        const firstPoint = equityData.series[0]
        const apps = provider ? [] : VENUE_APPS

        return apps
            .map((app) => {
                const latestValue = equityData.latest?.providers[app]
                if (latestValue === undefined) {
                    return null
                }

                const firstValue = firstPoint?.providers[app] ?? latestValue
                return {
                    app,
                    latest: latestValue,
                    change: latestValue - firstValue,
                }
            })
            .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    }, [equityData, provider])

    if (equityData === undefined) {
        return (
            <div className="space-y-6">
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-[400px] w-full" />
            </div>
        )
    }

    const latestTotal = equityData.latest?.total ?? 0
    const periodChange = latestTotal - (equityData.series[0]?.total ?? latestTotal)

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-4">
                <ProviderFilter selected={provider} onSelect={setProvider} />
                <FreshnessHeader freshness={freshnessStates} />
            </div>

            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <h2 className="text-lg font-semibold">Portfolio Equity Over Time</h2>
                    <p className="text-sm text-muted-foreground">
                        {provider
                            ? "Provider-truth equity for the selected venue"
                            : "Combined provider-truth equity across all venue accounts"}
                    </p>
                </div>
                <FilterBar
                    items={TIME_RANGES.map((range) => range.value)}
                    selected={timeRange}
                    onSelect={setTimeRange}
                    getLabel={(value) => TIME_RANGES.find((range) => range.value === value)!.label}
                    variant="tabs"
                />
            </div>

            {equityData.latest ? (
                <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
                    <StatCard
                        label={provider ? `${VENUE_META[provider].shortLabel} Equity` : "Total Equity"}
                        value={latestTotal}
                        format="currency"
                        size="2xl"
                    />
                    <StatCard
                        label="Period Change"
                        value={periodChange}
                        format="pnl"
                        size="2xl"
                    />
                    {providerStats.map((appData) => {
                        const meta = VENUE_META[appData.app]
                        return (
                            <StatCard
                                key={appData.app}
                                label={meta.shortLabel}
                                value={appData.latest}
                                format="currency"
                                size="lg"
                            >
                                <p className="text-lg font-semibold tabular-nums font-mono">
                                    {formatCurrency(appData.latest)}
                                </p>
                                <PnlText value={appData.change} className="text-xs" />
                            </StatCard>
                        )
                    })}
                </div>
            ) : null}

            <PortfolioSection>
                <EquityChart data={chartData} timeRange={timeRange} />
            </PortfolioSection>
        </div>
    )
}

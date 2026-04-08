"use client"

import { useState } from "react"
import { useQuery } from "convex/react"
import { api } from "@valiq-trading/convex"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { VenueBadge } from "@/components/venue-badge"
import { StatusBadge } from "@/components/status-badge"
import { PageSkeleton } from "@/components/page-skeleton"
import { FilterBar } from "@/components/filter-bar"
import { EmptyState } from "@/components/empty-state"
import { formatTimestamp } from "@/lib/format"
import { VENUE_APPS, VENUE_META, type VenueApp } from "@/lib/constants"
import { List } from "lucide-react"

export default function TradesPage() {
    const [selectedApp, setSelectedApp] = useState<string | null>(null)
    const trades = useQuery(api.queries.getTradeHistory, {
        app: selectedApp as VenueApp | undefined,
        limit: 100,
    })
    const allStrategies = useQuery(api.queries.getAllStrategies, {})

    if (trades === undefined || allStrategies === undefined) {
        return <PageSkeleton count={5} />
    }

    const strategyMap = new Map(
        allStrategies.map((s) => [String(s._id), s]),
    )

    return (
        <div className="space-y-4">
            <FilterBar
                items={[null, ...VENUE_APPS] as const}
                selected={selectedApp as string | null}
                onSelect={(v) => setSelectedApp(v)}
                getLabel={(v) => v === null ? "All" : VENUE_META[v as VenueApp].shortLabel}
            />

            {trades.length === 0 ? (
                <EmptyState
                    icon={List}
                    title="No trade events"
                    description="Trade events will appear here when strategies execute"
                />
            ) : (
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="text-base">
                            Trade Events ({trades.length})
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b text-left text-muted-foreground">
                                        <th className="pb-2 pr-4 font-medium">Time</th>
                                        <th className="pb-2 pr-4 font-medium">Type</th>
                                        <th className="pb-2 pr-4 font-medium">Strategy</th>
                                        <th className="pb-2 font-medium">Details</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {trades.map((event) => {
                                        const strategy = strategyMap.get(String(event.strategyId))
                                        let summary = ""
                                        try {
                                            const p = JSON.parse(event.payload)
                                            if (p.intent?.instrument) summary = p.intent.instrument
                                            else if (p.instrument) summary = p.instrument
                                            else if (p.result?.orderId) summary = `Order ${p.result.orderId}`
                                        } catch { /* ignore */ }
                                        return (
                                            <tr key={event._id} className="border-b border-border-subtle last:border-0">
                                                <td className="py-2 pr-4 text-xs text-muted-foreground whitespace-nowrap">
                                                    {formatTimestamp(event.timestamp)}
                                                </td>
                                                <td className="py-2 pr-4">
                                                    <StatusBadge
                                                        status={event.eventType}
                                                        category="event"
                                                    />
                                                </td>
                                                <td className="py-2 pr-4">
                                                    <div className="flex items-center gap-2">
                                                        {strategy ? (
                                                            <>
                                                                <VenueBadge app={strategy.app} />
                                                                <span className="text-xs truncate max-w-[120px]">
                                                                    {strategy.name}
                                                                </span>
                                                            </>
                                                        ) : (
                                                            <span className="text-xs text-muted-foreground">Unknown</span>
                                                        )}
                                                    </div>
                                                </td>
                                                <td className="py-2 text-xs font-mono text-muted-foreground truncate max-w-[200px]">
                                                    {summary}
                                                </td>
                                            </tr>
                                        )
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </CardContent>
                </Card>
            )}
        </div>
    )
}

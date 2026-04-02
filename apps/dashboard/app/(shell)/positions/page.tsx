"use client"

import { useDashboardOverview } from "@/hooks/use-dashboard-overview"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { PageSkeleton } from "@/components/page-skeleton"
import { VenueBadge } from "@/components/venue-badge"
import { PnlText } from "@/components/pnl-text"
import { EmptyState } from "@/components/empty-state"
import { formatCurrency } from "@/lib/format"
import { Activity } from "lucide-react"

function PositionCard({ pos }: {
    pos: {
        app: string
        instrument: string
        side: string
        quantity: number
        entryPrice: number
        currentPrice?: number | null
        unrealizedPnl?: number | null
        strategy?: { name: string } | null
    }
}) {
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

export default function PositionsPage() {
    const { data: overview, isLoading } = useDashboardOverview()

    if (isLoading || !overview) {
        return <PageSkeleton count={1} height="h-64" />
    }

    const positions = overview.openPositions

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

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                    {positions.length} open position{positions.length !== 1 ? "s" : ""}
                </p>
                <div className="flex items-center gap-2 text-sm">
                    <span className="text-muted-foreground">Total P&L:</span>
                    <PnlText value={totalUnrealizedPnl} className="font-semibold" />
                </div>
            </div>

            <div className="space-y-2 sm:hidden">
                {positions.map((pos, i) => (
                    <PositionCard key={i} pos={pos} />
                ))}
            </div>

            <Card className="hidden sm:block">
                <CardContent className="pt-6">
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
                                {positions.map((pos, i) => (
                                    <tr key={i} className="border-b border-border-subtle last:border-0">
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
        </div>
    )
}

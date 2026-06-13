"use client"

import { useState, useMemo } from "react"
import { useQuery } from "convex/react"
import { api } from "@valiq-trading/convex"
import {
    DataTable,
    CardList,
    PortfolioSection,
    ProviderFilter,
    FreshnessHeader,
    SideBadge,
    EquityChart,
    TradeHistoryTable,
    TIME_RANGES,
    type Column,
    type TimeRange,
    type PortfolioTradeRow,
} from "@/components/portfolio"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { PageSkeleton } from "@/components/page-skeleton"
import { VenueBadge } from "@/components/venue-badge"
import { StatusBadge } from "@/components/status-badge"
import { PnlText } from "@/components/pnl-text"
import { EmptyState } from "@/components/empty-state"
import { FilterBar } from "@/components/filter-bar"
import { formatCurrency, formatRelativeTime } from "@/lib/format"
import type { VenueApp } from "@/lib/constants"
import { usePortfolioFreshness } from "@/hooks/use-portfolio-freshness"
import { useProviderFilter } from "@/hooks/use-provider-filter"
import { Activity, ClipboardList } from "lucide-react"

type PortfolioPosition = {
    app: string
    accountId: string
    providerPositionId?: string
    strategyId?: string
    strategyName?: string
    ownershipStatus: string
    expectedExternal?: boolean
    instrument: string
    side: string
    quantity: number
    entryPrice: number
    currentPrice?: number
    unrealizedPnl?: number
    stopLoss?: number
    takeProfit?: number
    syncedAt: number
}

type PortfolioPendingOrder = {
    app: string
    accountId: string
    strategyId?: string
    strategyName?: string
    ownershipStatus: string
    expectedExternal?: boolean
    orderId: string
    instrument: string
    venue: string
    status: string
    action?: string
    side?: string
    quantity: number
    filledQuantity: number
    remainingQuantity: number
    limitPrice?: number
    stopPrice?: number
    avgFillPrice?: number
    submittedAt: number
    updatedAt: number
    cancelAt?: number
}

function renderOwnershipLabel(row: {
    strategyName?: string
    ownershipStatus: string
    expectedExternal?: boolean
}) {
    if (row.expectedExternal) {
        return (
            <span className="inline-flex items-center gap-1.5">
                <span>Expected External</span>
                <Badge variant="outline" className="text-[10px] leading-none">manual</Badge>
            </span>
        )
    }

    if (row.ownershipStatus === "owned") {
        return (
            <span className="inline-flex items-center gap-1.5">
                <span>{row.strategyName ?? "Owned"}</span>
                <Badge variant="outline" className="text-[10px] leading-none">owned</Badge>
            </span>
        )
    }

    if (row.ownershipStatus === "orphaned") {
        return (
            <span className="inline-flex items-center gap-1.5">
                <span>Orphaned</span>
                <Badge variant="destructive" className="text-[10px] leading-none">conflict</Badge>
            </span>
        )
    }

    return "Unowned"
}

function renderPendingOrderOwnershipLabel(order: PortfolioPendingOrder) {
    if (!isLiveWorkingOrderStatus(order.status)) {
        return (
            <span className="inline-flex items-center gap-1.5">
                <span>Stale Persisted</span>
                <Badge variant="outline" className="text-[10px] leading-none">terminal</Badge>
            </span>
        )
    }

    return renderOwnershipLabel(order)
}

function isLiveWorkingOrderStatus(status: string): boolean {
    return status === "pending" || status === "partially_filled"
}

function getPositionKey(pos: PortfolioPosition) {
    return [pos.app, pos.accountId, pos.instrument, pos.side, pos.quantity, pos.entryPrice].join(":")
}

function formatLevel(value: number | undefined): string {
    if (value === undefined) return "--"
    return formatCurrency(value)
}

const positionColumns: Column<PortfolioPosition>[] = [
    {
        key: "venue",
        header: "Venue",
        render: (pos) => <VenueBadge app={pos.app} />,
    },
    {
        key: "account",
        header: "Account",
        cellClassName: "font-mono text-xs",
        render: (pos) => pos.accountId,
    },
    {
        key: "strategy",
        header: "Strategy",
        cellClassName: "truncate max-w-[120px]",
        render: (pos) => renderOwnershipLabel(pos),
    },
    {
        key: "instrument",
        header: "Instrument",
        cellClassName: "font-mono text-xs",
        render: (pos) => pos.instrument,
    },
    {
        key: "side",
        header: "Side",
        render: (pos) => <SideBadge side={pos.side} />,
    },
    {
        key: "quantity",
        header: "Qty",
        align: "right",
        cellClassName: "font-mono tabular-nums",
        render: (pos) => pos.quantity,
    },
    {
        key: "entry",
        header: "Entry",
        align: "right",
        cellClassName: "font-mono tabular-nums",
        render: (pos) => formatCurrency(pos.entryPrice),
    },
    {
        key: "current",
        header: "Current",
        align: "right",
        cellClassName: "font-mono tabular-nums",
        render: (pos) => pos.currentPrice != null ? formatCurrency(pos.currentPrice) : "--",
    },
    {
        key: "sl",
        header: "SL",
        align: "right",
        cellClassName: "font-mono tabular-nums text-xs",
        render: (pos) => (
            <span className={pos.stopLoss !== undefined ? "text-loss" : "text-muted-foreground"}>
                {formatLevel(pos.stopLoss)}
            </span>
        ),
    },
    {
        key: "tp",
        header: "TP",
        align: "right",
        cellClassName: "font-mono tabular-nums text-xs",
        render: (pos) => (
            <span className={pos.takeProfit !== undefined ? "text-profit" : "text-muted-foreground"}>
                {formatLevel(pos.takeProfit)}
            </span>
        ),
    },
    {
        key: "pnl",
        header: "P&L",
        align: "right",
        render: (pos) => <PnlText value={pos.unrealizedPnl ?? 0} className="text-xs" />,
    },
]

const pendingOrderColumns: Column<PortfolioPendingOrder>[] = [
    {
        key: "venue",
        header: "Venue",
        render: (order) => <VenueBadge app={order.app} />,
    },
    {
        key: "account",
        header: "Account",
        cellClassName: "font-mono text-xs",
        render: (order) => order.accountId,
    },
    {
        key: "strategy",
        header: "Strategy",
        cellClassName: "truncate max-w-[120px]",
        render: (order) => renderPendingOrderOwnershipLabel(order),
    },
    {
        key: "instrument",
        header: "Instrument",
        cellClassName: "font-mono text-xs",
        render: (order) => order.instrument,
    },
    {
        key: "side",
        header: "Side",
        render: (order) => order.side ? <SideBadge side={order.side} /> : "--",
    },
    {
        key: "action",
        header: "Action",
        render: (order) => order.action
            ? <StatusBadge status={order.action} category="event" fallback="secondary" />
            : "--",
    },
    {
        key: "status",
        header: "Status",
        render: (order) => <StatusBadge status={order.status} category="event" fallback="secondary" />,
    },
    {
        key: "qty",
        header: "Qty",
        align: "right",
        cellClassName: "font-mono tabular-nums",
        render: (order) => `${order.filledQuantity}/${order.quantity}`,
    },
    {
        key: "limit",
        header: "Limit",
        align: "right",
        cellClassName: "font-mono tabular-nums",
        render: (order) => order.limitPrice != null ? formatCurrency(order.limitPrice) : "--",
    },
    {
        key: "updated",
        header: "Updated",
        cellClassName: "text-xs text-muted-foreground whitespace-nowrap",
        render: (order) => formatRelativeTime(order.updatedAt),
    },
    {
        key: "ttl",
        header: "TTL",
        cellClassName: "text-xs whitespace-nowrap",
        render: (order) => {
            if (order.cancelAt === undefined) {
                return <span className="text-muted-foreground">--</span>
            }
            if (order.cancelAt <= Date.now()) {
                return <span className="text-loss">expired</span>
            }
            return (
                <span className="text-muted-foreground">
                    {formatRelativeTime(order.cancelAt)}
                </span>
            )
        },
    },
]

function PositionsTab({ positions }: { positions: PortfolioPosition[] }) {
    const totalPnl = positions.reduce((sum, p) => sum + (p.unrealizedPnl ?? 0), 0)

    if (positions.length === 0) {
        return (
            <EmptyState
                icon={Activity}
                title="No open positions"
                description="Open positions across all venues will appear here"
            />
        )
    }

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">
                    {positions.length} open position{positions.length !== 1 ? "s" : ""}
                </p>
                <div className="flex items-center gap-2 text-sm">
                    <span className="text-muted-foreground">Total P&L:</span>
                    <PnlText value={totalPnl} className="font-semibold" />
                </div>
            </div>

            <div className="sm:hidden">
                <CardList
                    data={positions}
                    getKey={getPositionKey}
                    renderCard={(pos) => (
                        <div className="rounded-lg border border-border-subtle p-3 space-y-2">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2 min-w-0">
                                    <span className="text-sm font-medium font-mono truncate">
                                        {pos.instrument}
                                    </span>
                                    <SideBadge side={pos.side} />
                                </div>
                                <PnlText
                                    value={pos.unrealizedPnl ?? 0}
                                    className="text-sm font-medium shrink-0"
                                />
                            </div>
                            <div className="flex items-center justify-between text-xs text-muted-foreground">
                                <div className="flex items-center gap-2">
                                    <VenueBadge app={pos.app} />
                                    <span className="font-mono truncate max-w-[90px]">
                                        {pos.accountId}
                                    </span>
                                    <span className="truncate max-w-[100px]">
                                        {pos.expectedExternal ? "Expected External" : (pos.strategyName ?? "Unowned")}
                                    </span>
                                </div>
                                <div className="flex items-center gap-3 font-mono tabular-nums shrink-0">
                                    <span>qty {pos.quantity}</span>
                                    <span>{formatCurrency(pos.entryPrice)}</span>
                                </div>
                            </div>
                            <div className="flex items-center justify-between text-xs">
                                <div className="flex items-center gap-3 font-mono tabular-nums">
                                    <span className={pos.stopLoss !== undefined ? "text-loss" : "text-muted-foreground"}>
                                        SL {formatLevel(pos.stopLoss)}
                                    </span>
                                    <span className={pos.takeProfit !== undefined ? "text-profit" : "text-muted-foreground"}>
                                        TP {formatLevel(pos.takeProfit)}
                                    </span>
                                </div>
                            </div>
                        </div>
                    )}
                />
            </div>

            <PortfolioSection className="hidden sm:block">
                <DataTable
                    columns={positionColumns}
                    data={positions}
                    getRowKey={getPositionKey}
                />
            </PortfolioSection>
        </div>
    )
}

function PendingOrdersTab({ orders }: { orders: PortfolioPendingOrder[] }) {
    if (orders.length === 0) {
        return (
            <EmptyState
                icon={ClipboardList}
                title="No pending orders"
                description="Working orders across all venues will appear here"
            />
        )
    }

    return (
        <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
                {orders.length} pending order{orders.length !== 1 ? "s" : ""}
            </p>

            <div className="sm:hidden">
                <CardList
                    data={orders}
                    getKey={(o) => o.orderId}
                    renderCard={(order) => (
                        <div className="rounded-lg border border-border-subtle p-3 space-y-2">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2 min-w-0">
                                    <span className="text-sm font-medium font-mono truncate">
                                        {order.instrument}
                                    </span>
                                    {order.side ? <SideBadge side={order.side} /> : null}
                                </div>
                                <StatusBadge status={order.status} category="event" fallback="secondary" />
                            </div>
                            <div className="flex items-center justify-between text-xs text-muted-foreground">
                                <div className="flex items-center gap-2">
                                    <VenueBadge app={order.app} />
                                    <span className="font-mono truncate max-w-[90px]">
                                        {order.accountId}
                                    </span>
                                    <span className="truncate max-w-[100px]">
                                        {order.expectedExternal
                                            ? "Expected External"
                                            : !isLiveWorkingOrderStatus(order.status)
                                                ? "Stale Persisted"
                                                : order.ownershipStatus === "orphaned"
                                                    ? "Orphaned"
                                                    : order.strategyName ?? "Unowned"}
                                    </span>
                                </div>
                                <div className="flex items-center gap-3 font-mono tabular-nums shrink-0">
                                    <span>{order.filledQuantity}/{order.quantity}</span>
                                    {order.limitPrice != null ? (
                                        <span>@ {formatCurrency(order.limitPrice)}</span>
                                    ) : null}
                                </div>
                            </div>
                        </div>
                    )}
                />
            </div>

            <PortfolioSection className="hidden sm:block">
                <DataTable
                    columns={pendingOrderColumns}
                    data={orders}
                    getRowKey={(o) => o.orderId}
                />
            </PortfolioSection>
        </div>
    )
}

function TradeHistoryTab({ trades }: { trades: PortfolioTradeRow[] }) {
    return <TradeHistoryTable trades={trades} />
}

function EquityTab({
    provider,
}: {
    provider: VenueApp | null
}) {
    const [timeRange, setTimeRange] = useState<TimeRange>("30d")
    const equityData = useQuery(api.queries.getPortfolioEquitySeries, {
        app: provider ?? undefined,
        timeRange,
    })

    const chartData = useMemo(() => {
        if (!equityData || equityData.series.length === 0) return []

        return equityData.series.map((point) => ({
            timestamp: point.timestamp,
            total: point.total,
            ...point.providers,
        }))
    }, [equityData])

    if (equityData === undefined) {
        return <PageSkeleton count={1} height="h-[400px]" />
    }

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                    Equity curve across {provider ? "selected venue" : "all venues"}
                </p>
                <FilterBar
                    items={TIME_RANGES.map((r) => r.value)}
                    selected={timeRange}
                    onSelect={setTimeRange}
                    getLabel={(v) => TIME_RANGES.find((r) => r.value === v)!.label}
                    variant="tabs"
                />
            </div>

            {equityData.latest ? (
                <div className="flex items-center gap-4 text-sm">
                    <span className="text-muted-foreground">Latest equity:</span>
                    <span className="font-semibold font-mono tabular-nums">
                        {formatCurrency(equityData.latest.total)}
                    </span>
                </div>
            ) : null}

            <PortfolioSection>
                <EquityChart data={chartData} timeRange={timeRange} />
            </PortfolioSection>
        </div>
    )
}

export default function PositionsPage() {
    const { provider, setProvider } = useProviderFilter()
    const freshnessStates = usePortfolioFreshness(provider)
    const positions = useQuery(api.queries.getPortfolioPositions, {
        app: provider ?? undefined,
    })
    const pendingOrders = useQuery(api.queries.getPortfolioPendingOrders, {
        app: provider ?? undefined,
    })
    const tradeHistory = useQuery(api.queries.getPortfolioTradeHistory, {
        app: provider ?? undefined,
        limit: 100,
    })

    const isLoading = positions === undefined
        || pendingOrders === undefined
        || tradeHistory === undefined

    if (isLoading) {
        return <PageSkeleton count={3} height="h-32" />
    }

    const positionCount = positions.length
    const orderCount = pendingOrders.length
    const tradeCount = tradeHistory.length

    return (
        <div className="space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <ProviderFilter selected={provider} onSelect={setProvider} />
            </div>

            <FreshnessHeader freshness={freshnessStates} />

            <Tabs defaultValue="positions">
                <TabsList>
                    <TabsTrigger value="positions">
                        Positions{positionCount > 0 ? ` (${positionCount})` : ""}
                    </TabsTrigger>
                    <TabsTrigger value="orders">
                        Orders{orderCount > 0 ? ` (${orderCount})` : ""}
                    </TabsTrigger>
                    <TabsTrigger value="trades">
                        Trades{tradeCount > 0 ? ` (${tradeCount})` : ""}
                    </TabsTrigger>
                    <TabsTrigger value="equity">
                        Equity
                    </TabsTrigger>
                </TabsList>

                <TabsContent value="positions">
                    <PositionsTab positions={positions as PortfolioPosition[]} />
                </TabsContent>

                <TabsContent value="orders">
                    <PendingOrdersTab orders={pendingOrders as PortfolioPendingOrder[]} />
                </TabsContent>

                <TabsContent value="trades">
                    <TradeHistoryTab trades={tradeHistory as PortfolioTradeRow[]} />
                </TabsContent>

                <TabsContent value="equity">
                    <EquityTab provider={provider} />
                </TabsContent>
            </Tabs>
        </div>
    )
}

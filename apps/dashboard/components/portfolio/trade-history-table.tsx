import { EmptyState } from "@/components/empty-state"
import { StatusBadge } from "@/components/status-badge"
import { VenueBadge } from "@/components/venue-badge"
import { Badge } from "@/components/ui/badge"
import { formatCurrency, formatTimestamp } from "@/lib/format"
import { List } from "lucide-react"
import { CardList } from "./card-list"
import { DataTable, type Column } from "./data-table"
import { PortfolioSection } from "./section"
import { SideBadge } from "./side-badge"

export type PortfolioTradeRow = {
    eventId: string
    timestamp: number
    app: string
    accountId: string
    strategyId: string
    strategyName: string
    runId: string
    orderId?: string
    instrument?: string
    eventType: string
    action?: string
    status?: string
    side?: string
    quantity?: number
    filledQuantity?: number
    price?: number
    accountingStatus?: "missing" | "estimated" | "provider"
    accountingSource?: string
    accountingMissingReason?: string
    summary: string
}

const tradeHistoryColumns: Column<PortfolioTradeRow>[] = [
    {
        key: "time",
        header: "Time",
        cellClassName: "text-xs text-muted-foreground whitespace-nowrap",
        render: (row) => formatTimestamp(row.timestamp),
    },
    {
        key: "type",
        header: "Type",
        render: (row) => <StatusBadge status={row.eventType} category="event" />,
    },
    {
        key: "venue",
        header: "Venue",
        render: (row) => <VenueBadge app={row.app} />,
    },
    {
        key: "account",
        header: "Account",
        cellClassName: "font-mono text-xs",
        render: (row) => row.accountId,
    },
    {
        key: "strategy",
        header: "Strategy",
        cellClassName: "text-xs truncate max-w-[120px]",
        render: (row) => row.strategyName,
    },
    {
        key: "instrument",
        header: "Instrument",
        cellClassName: "font-mono text-xs",
        render: (row) => row.instrument ?? "--",
    },
    {
        key: "side",
        header: "Side",
        render: (row) => row.side ? <SideBadge side={row.side} /> : "--",
    },
    {
        key: "qty",
        header: "Qty",
        align: "right",
        cellClassName: "font-mono tabular-nums",
        render: (row) => row.filledQuantity ?? row.quantity ?? "--",
    },
    {
        key: "price",
        header: "Price",
        align: "right",
        cellClassName: "font-mono tabular-nums",
        render: (row) => row.price != null ? formatCurrency(row.price) : "--",
    },
    {
        key: "accounting",
        header: "Accounting",
        render: (row) => renderAccountingBadge(row),
    },
    {
        key: "summary",
        header: "Summary",
        cellClassName: "text-xs text-muted-foreground truncate max-w-[200px]",
        render: (row) => row.summary,
    },
]

function renderAccountingBadge(row: PortfolioTradeRow) {
    if (row.accountingStatus === "missing") {
        return (
            <Badge variant="destructive" title={row.accountingMissingReason ?? row.accountingSource}>
                Missing
            </Badge>
        )
    }

    if (row.accountingStatus === "estimated") {
        return (
            <Badge variant="outline" title={row.accountingSource}>
                Estimated
            </Badge>
        )
    }

    if (row.accountingStatus === "provider") {
        return (
            <Badge variant="secondary" title={row.accountingSource}>
                Provider
            </Badge>
        )
    }

    return "--"
}

export function TradeHistoryTable({
    trades,
    title,
}: {
    trades: PortfolioTradeRow[]
    title?: string
}) {
    if (trades.length === 0) {
        return (
            <EmptyState
                icon={List}
                title="No trade events"
                description="Trade events will appear here when strategies execute"
            />
        )
    }

    return (
        <div className="space-y-3">
            <p className={title ? "text-sm text-muted-foreground sm:hidden" : "text-sm text-muted-foreground"}>
                {trades.length} trade event{trades.length !== 1 ? "s" : ""}
            </p>

            <div className="sm:hidden">
                <CardList
                    data={trades}
                    getKey={(trade) => trade.eventId}
                    renderCard={(row) => (
                        <div className="rounded-lg border border-border-subtle p-3 space-y-2">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2 min-w-0">
                                    <StatusBadge status={row.eventType} category="event" />
                                    {row.accountingStatus ? renderAccountingBadge(row) : null}
                                    <span className="text-sm font-medium font-mono truncate">
                                        {row.instrument ?? "--"}
                                    </span>
                                </div>
                                {row.price != null ? (
                                    <span className="text-sm font-mono tabular-nums shrink-0">
                                        {formatCurrency(row.price)}
                                    </span>
                                ) : null}
                            </div>
                            <div className="flex items-center justify-between text-xs text-muted-foreground">
                                <div className="flex items-center gap-2">
                                    <VenueBadge app={row.app} />
                                    <span className="font-mono truncate max-w-[90px]">{row.accountId}</span>
                                    <span className="truncate max-w-[100px]">{row.strategyName}</span>
                                </div>
                                <span className="whitespace-nowrap shrink-0">
                                    {formatTimestamp(row.timestamp)}
                                </span>
                            </div>
                        </div>
                    )}
                />
            </div>

            <PortfolioSection className="hidden sm:block" title={title} count={title ? trades.length : undefined}>
                <DataTable
                    columns={tradeHistoryColumns}
                    data={trades}
                    getRowKey={(trade) => trade.eventId}
                />
            </PortfolioSection>
        </div>
    )
}

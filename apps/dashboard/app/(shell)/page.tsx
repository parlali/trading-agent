"use client"

import { useDashboardOverview } from "@/hooks/use-dashboard-overview"
import { isHeartbeatStale } from "@/lib/heartbeat"
import Link from "next/link"
import {
    AlertTriangle,
    CheckCircle2,
    ChevronRight,
    CircleDollarSign,
    Layers,
    Plus,
    Server,
    ShieldAlert,
    SlidersHorizontal,
    XCircle,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { VenueBadge } from "@/components/venue-badge"
import { StatusBadge } from "@/components/status-badge"
import { PnlText } from "@/components/pnl-text"
import { formatCurrency, formatRelativeTime } from "@/lib/format"
import { ACTIVE_VENUE_APPS, VENUE_META } from "@/lib/constants"

function OverviewSkeleton() {
    return (
        <div className="space-y-6">
            <Card>
                <CardHeader>
                    <Skeleton className="h-5 w-40" />
                </CardHeader>
                <CardContent className="space-y-3">
                    {Array.from({ length: 4 }).map((_, i) => (
                        <Skeleton key={i} className="h-16 w-full" />
                    ))}
                </CardContent>
            </Card>
            <Card>
                <CardHeader>
                    <Skeleton className="h-5 w-44" />
                </CardHeader>
                <CardContent>
                    <Skeleton className="h-28 w-full" />
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

type AccountRow = {
    _id: string
    app: string
    accountId: string
    label: string
    status: "active" | "disabled"
    credentialEnvPrefix: string
    notes?: string
    latestSnapshot?: {
        equity?: number
        balance: number
        openPnl: number
        dayPnl?: number
        timestamp: number
    } | null
    syncState?: {
        providerStatus: string
        stale: boolean
        driftDetected: boolean
        lastVerifiedAt?: number
        lastSyncedAt?: number
        lastDriftSummary?: string
        positionCount: number
        pendingOrderCount: number
    } | null
    strategyCount: number
    enabledStrategyCount: number
    blockedStrategyCount: number
    unresolvedFaultCount: number
    unresolvedBlockingFaultCount: number
    latestPnlEvent?: {
        eventType: string
        amount: number
        currency: string
        occurredAt: number
    } | null
}

type ModelComparisonRow = {
    strategyId: string
    strategyName: string
    app: string
    accountId: string
    model: string
    enabled: boolean
    equity: number | null
    openPnl: number | null
    dayPnl: number | null
    opportunityRealizedPnl: number | null
    latestRun?: {
        status: string
        startedAt: number
    } | null
}

type MoneyAuditAlert = {
    _id: string
    app?: string
    severity: string
    message: string
    acknowledged: boolean
    timestamp: number
}

type ExecutionFault = {
    _id: string
    strategyId: string
    strategyName: string
    app: string
    accountId: string
    instrument: string
    category: string
    message: string
    blocked: boolean
    occurredAt: number
}

function resolveAccountEquity(account: AccountRow): number | undefined {
    const snapshot = account.latestSnapshot
    if (!snapshot) {
        return undefined
    }

    return snapshot.equity ?? snapshot.balance + snapshot.openPnl
}

function accountHealth(account: AccountRow): {
    status: string
    variant: "default" | "secondary" | "destructive" | "outline"
} {
    if (account.status !== "active") {
        return { status: "disabled", variant: "outline" }
    }

    if (account.unresolvedBlockingFaultCount > 0 || account.blockedStrategyCount > 0) {
        return { status: "blocked", variant: "destructive" }
    }

    if (account.syncState?.driftDetected || account.syncState?.providerStatus === "degraded") {
        return { status: "drift", variant: "secondary" }
    }

    if (!account.syncState || account.syncState.stale) {
        return { status: "stale", variant: "secondary" }
    }

    return { status: "healthy", variant: "default" }
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
        <div className="flex items-center justify-between rounded-lg border border-border-subtle p-3">
            <div className="flex items-center gap-3 min-w-0">
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

function AccountCard({ account }: { account: AccountRow }) {
    const health = accountHealth(account)
    const equity = resolveAccountEquity(account)
    const summary = account.syncState?.lastDriftSummary

    return (
        <Card>
            <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                        <div className="flex items-center gap-2 min-w-0">
                            <VenueBadge app={account.app} />
                            <p className="text-sm font-semibold truncate">{account.label}</p>
                        </div>
                        <p className="font-mono text-xs text-muted-foreground truncate">{account.accountId}</p>
                    </div>
                    <Badge variant={health.variant} className="text-xs shrink-0">
                        {health.status}
                    </Badge>
                </div>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">Equity</p>
                        <p className="font-mono text-sm tabular-nums">
                            {equity === undefined ? "--" : formatCurrency(equity)}
                        </p>
                    </div>
                    <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">Open P&L</p>
                        {account.latestSnapshot ? (
                            <PnlText value={account.latestSnapshot.openPnl} className="text-sm" />
                        ) : (
                            <p className="text-sm text-muted-foreground">--</p>
                        )}
                    </div>
                    <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">Strategies</p>
                        <p className="font-mono text-sm">{account.enabledStrategyCount}/{account.strategyCount}</p>
                    </div>
                    <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">Exposure</p>
                        <p className="font-mono text-sm">
                            {account.syncState ? `${account.syncState.positionCount}/${account.syncState.pendingOrderCount}` : "--"}
                        </p>
                    </div>
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-border-subtle pt-3">
                    <div className="min-w-0">
                        <p className="text-xs text-muted-foreground">Reconciliation</p>
                        <p className="text-xs truncate">
                            {account.syncState?.lastVerifiedAt
                                ? formatRelativeTime(account.syncState.lastVerifiedAt)
                                : "not verified"}
                        </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        {account.unresolvedFaultCount > 0 ? (
                            <Badge variant="destructive" className="text-xs">
                                {account.unresolvedFaultCount} fault{account.unresolvedFaultCount === 1 ? "" : "s"}
                            </Badge>
                        ) : null}
                        <Button size="xs" variant="outline" asChild>
                            <Link href={`/strategies/new`}>
                                <Plus className="h-3 w-3" />
                                Assign
                            </Link>
                        </Button>
                    </div>
                </div>
                {summary ? (
                    <div className="rounded-md border border-signal-warning/30 bg-signal-warning/10 p-3 text-xs text-foreground">
                        {summary}
                    </div>
                ) : null}
            </CardContent>
        </Card>
    )
}

function MoneyAuditSection({ alerts }: { alerts: MoneyAuditAlert[] }) {
    return (
        <Card>
            <CardHeader>
                <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-base flex items-center gap-2">
                        <CircleDollarSign className="h-4 w-4" />
                        Daily Money Audit
                    </CardTitle>
                    <Badge variant={alerts.length > 0 ? "destructive" : "default"} className="text-xs">
                        {alerts.length > 0 ? `${alerts.length} mismatch${alerts.length === 1 ? "" : "es"}` : "clear"}
                    </Badge>
                </div>
            </CardHeader>
            <CardContent>
                {alerts.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        No money-level reconciliation mismatches in recent alerts.
                    </p>
                ) : (
                    <div className="space-y-2">
                        {alerts.slice(0, 5).map((alert) => (
                            <div key={alert._id} className="rounded-lg border border-signal-warning/30 bg-signal-warning/10 p-3">
                                <div className="flex items-center justify-between gap-3">
                                    <Badge variant="secondary" className="text-xs">
                                        {alert.app ?? "system"}
                                    </Badge>
                                    <span className="text-xs text-muted-foreground shrink-0">
                                        {formatRelativeTime(alert.timestamp)}
                                    </span>
                                </div>
                                <p className="mt-2 text-xs leading-relaxed">{alert.message}</p>
                            </div>
                        ))}
                    </div>
                )}
            </CardContent>
        </Card>
    )
}

function ModelComparisonTable({ rows }: { rows: ModelComparisonRow[] }) {
    return (
        <Card>
            <CardHeader>
                <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-base flex items-center gap-2">
                        <Layers className="h-4 w-4" />
                        Model Comparison
                    </CardTitle>
                    <Button size="xs" variant="outline" asChild>
                        <Link href="/strategies">
                            <SlidersHorizontal className="h-3 w-3" />
                            Manage
                        </Link>
                    </Button>
                </div>
            </CardHeader>
            <CardContent>
                {rows.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4 text-center">
                        No strategies configured yet
                    </p>
                ) : (
                    <div className="overflow-x-auto">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Strategy</TableHead>
                                    <TableHead>Model</TableHead>
                                    <TableHead>Account</TableHead>
                                    <TableHead className="text-right">Equity</TableHead>
                                    <TableHead className="text-right">Day P&L</TableHead>
                                    <TableHead className="text-right">Run P&L</TableHead>
                                    <TableHead>Latest Run</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {rows.map((row) => (
                                    <TableRow key={row.strategyId}>
                                        <TableCell>
                                            <Link href={`/strategies/${row.strategyId}`} className="font-medium hover:underline">
                                                {row.strategyName}
                                            </Link>
                                        </TableCell>
                                        <TableCell className="font-mono text-xs max-w-[220px] truncate">
                                            {row.model}
                                        </TableCell>
                                        <TableCell>
                                            <div className="flex items-center gap-2">
                                                <VenueBadge app={row.app} />
                                                <span className="font-mono text-xs">{row.accountId}</span>
                                            </div>
                                        </TableCell>
                                        <TableCell className="text-right font-mono tabular-nums">
                                            {row.equity === null ? "--" : formatCurrency(row.equity)}
                                        </TableCell>
                                        <TableCell className="text-right">
                                            {row.dayPnl === null ? (
                                                <span className="text-muted-foreground">--</span>
                                            ) : (
                                                <PnlText value={row.dayPnl} className="text-xs" />
                                            )}
                                        </TableCell>
                                        <TableCell className="text-right">
                                            {row.opportunityRealizedPnl === null ? (
                                                <span className="text-muted-foreground">--</span>
                                            ) : (
                                                <PnlText value={row.opportunityRealizedPnl} className="text-xs" />
                                            )}
                                        </TableCell>
                                        <TableCell>
                                            {row.latestRun ? (
                                                <div className="flex items-center gap-2">
                                                    <StatusBadge status={row.latestRun.status} category="run" />
                                                    <span className="text-xs text-muted-foreground">
                                                        {formatRelativeTime(row.latestRun.startedAt)}
                                                    </span>
                                                </div>
                                            ) : (
                                                <span className="text-xs text-muted-foreground">never</span>
                                            )}
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                )}
            </CardContent>
        </Card>
    )
}

function FaultTriage({ faults }: { faults: ExecutionFault[] }) {
    return (
        <Card>
            <CardHeader>
                <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-base flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4" />
                        Fault Triage
                    </CardTitle>
                    <Badge variant={faults.length > 0 ? "destructive" : "default"} className="text-xs">
                        {faults.length} open
                    </Badge>
                </div>
            </CardHeader>
            <CardContent>
                {faults.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No unresolved execution safety faults.</p>
                ) : (
                    <div className="space-y-2">
                        {faults.slice(0, 8).map((fault) => (
                            <Link
                                key={fault._id}
                                href={`/strategies/${fault.strategyId}`}
                                className="block rounded-lg border border-border-subtle p-3 transition-colors hover:bg-muted/50 hover:border-border"
                            >
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <VenueBadge app={fault.app} />
                                            <span className="text-sm font-medium truncate">{fault.strategyName}</span>
                                            <Badge variant={fault.blocked ? "destructive" : "secondary"} className="text-xs">
                                                {fault.category}
                                            </Badge>
                                        </div>
                                        <p className="mt-1 font-mono text-xs text-muted-foreground truncate">
                                            {fault.accountId} / {fault.instrument}
                                        </p>
                                        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                                            {fault.message}
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                        <span className="text-xs text-muted-foreground">
                                            {formatRelativeTime(fault.occurredAt)}
                                        </span>
                                        <ChevronRight className="h-4 w-4 text-muted-foreground/50" />
                                    </div>
                                </div>
                            </Link>
                        ))}
                    </div>
                )}
            </CardContent>
        </Card>
    )
}

export default function OverviewPage() {
    const { data, isLoading } = useDashboardOverview()

    if (isLoading || !data) return <OverviewSkeleton />

    const isGlobalKilled = data.systemState.globalKillSwitch
    const killSwitches = data.systemState.appKillSwitches ?? {}
    const accounts = data.accounts as AccountRow[]
    const modelComparison = data.modelComparison as ModelComparisonRow[]
    const moneyAuditAlerts = data.moneyAuditAlerts as MoneyAuditAlert[]
    const unresolvedFaults = data.unresolvedFaults as ExecutionFault[]

    const backendHeartbeat = data.appHealth.find((h) => h.app === "backend") as Heartbeat | undefined
    const venueHeartbeats = ACTIVE_VENUE_APPS.map((app) => ({
        app,
        heartbeat: data.appHealth.find((h) => h.app === app) as Heartbeat | undefined,
    }))
    const activeAccounts = accounts.filter((account) => account.status === "active").length
    const blockedAccounts = accounts.filter((account) => accountHealth(account).status === "blocked").length
    const driftAccounts = accounts.filter((account) => accountHealth(account).status === "drift").length

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

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Card>
                    <CardContent className="p-4">
                        <p className="text-xs text-muted-foreground">Active Accounts</p>
                        <p className="mt-1 text-2xl font-semibold tabular-nums">{activeAccounts}/{accounts.length}</p>
                    </CardContent>
                </Card>
                <Card>
                    <CardContent className="p-4">
                        <p className="text-xs text-muted-foreground">Blocked Accounts</p>
                        <p className="mt-1 text-2xl font-semibold tabular-nums text-signal-danger">{blockedAccounts}</p>
                    </CardContent>
                </Card>
                <Card>
                    <CardContent className="p-4">
                        <p className="text-xs text-muted-foreground">Reconciliation Drift</p>
                        <p className="mt-1 text-2xl font-semibold tabular-nums text-signal-warning">{driftAccounts}</p>
                    </CardContent>
                </Card>
            </div>

            <Card>
                <CardHeader>
                    <div className="flex items-center justify-between gap-2">
                        <CardTitle className="text-base flex items-center gap-2">
                            <Server className="h-4 w-4" />
                            Runtime Status
                        </CardTitle>
                        <Button size="xs" variant="outline" asChild>
                            <Link href="/system/health">Health</Link>
                        </Button>
                    </div>
                </CardHeader>
                <CardContent className="grid grid-cols-1 gap-3 lg:grid-cols-2">
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
                    <div className="flex items-center justify-between gap-2">
                        <CardTitle className="text-base">Account Pool</CardTitle>
                        <Button size="xs" variant="outline" asChild>
                            <Link href="/strategies/new">
                                <Plus className="h-3 w-3" />
                                Assign Strategy
                            </Link>
                        </Button>
                    </div>
                </CardHeader>
                <CardContent>
                    {accounts.length === 0 ? (
                        <p className="text-sm text-muted-foreground py-4 text-center">
                            No accounts declared in the managed pool.
                        </p>
                    ) : (
                        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                            {accounts.map((account) => (
                                <AccountCard key={account._id} account={account} />
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.6fr)]">
                <ModelComparisonTable rows={modelComparison} />
                <div className="space-y-6">
                    <MoneyAuditSection alerts={moneyAuditAlerts} />
                    <FaultTriage faults={unresolvedFaults} />
                </div>
            </div>
        </div>
    )
}

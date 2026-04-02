"use client"

import { useMutation } from "convex/react"
import { api } from "@valiq-trading/convex"
import { useDashboardOverview } from "@/hooks/use-dashboard-overview"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { VenueBadge } from "@/components/venue-badge"
import { StatusDot } from "@/components/status-dot"
import { StatusBadge } from "@/components/status-badge"
import { PageSkeleton } from "@/components/page-skeleton"
import { EmptyState } from "@/components/empty-state"
import { formatRelativeTime } from "@/lib/format"
import { VENUE_APPS, VENUE_META, type VenueApp } from "@/lib/constants"
import { ChevronRight, Layers, Play, Plus } from "lucide-react"
import { toast } from "sonner"

function StrategyCard({ strategy, onRun }: {
    strategy: {
        _id: string
        name: string
        app: string
        enabled: boolean
        schedule: string
        latestRun?: { status: string, startedAt: number } | null
    }
    onRun: () => void
}) {
    const router = useRouter()
    const isRunning = strategy.latestRun?.status === "running"

    return (
        <div
            role="button"
            tabIndex={0}
            onClick={() => router.push(`/strategies/${strategy._id}`)}
            onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault()
                    router.push(`/strategies/${strategy._id}`)
                }
            }}
            className="flex items-center justify-between rounded-lg border border-border-subtle bg-card p-3 sm:p-4 transition-colors hover:bg-muted/50 hover:border-border cursor-pointer group"
        >
            <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
                <StatusDot
                    status={
                        isRunning
                            ? "running"
                            : strategy.enabled
                                ? "healthy"
                                : "unhealthy"
                    }
                />
                <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{strategy.name}</p>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <code className="text-xs text-muted-foreground font-mono">
                            {strategy.schedule}
                        </code>
                        {!strategy.enabled ? (
                            <Badge variant="secondary" className="text-xs">disabled</Badge>
                        ) : null}
                    </div>
                </div>
            </div>
            <div className="flex items-center gap-2 sm:gap-3 shrink-0 ml-2">
                {strategy.latestRun ? (
                    <div className="text-right hidden sm:block">
                        <StatusBadge
                            status={strategy.latestRun.status}
                            category="run"
                        />
                        <p className="text-xs text-muted-foreground mt-1">
                            {formatRelativeTime(strategy.latestRun.startedAt)}
                        </p>
                    </div>
                ) : (
                    <span className="text-xs text-muted-foreground hidden sm:block">never run</span>
                )}
                <Button
                    size="sm"
                    variant="outline"
                    disabled={!strategy.enabled || isRunning}
                    onClick={(e) => {
                        e.stopPropagation()
                        onRun()
                    }}
                    className="h-8"
                >
                    <Play className="h-3 w-3" />
                    <span className="hidden sm:inline">Run</span>
                </Button>
                <ChevronRight className="h-4 w-4 text-muted-foreground/50 group-hover:text-muted-foreground transition-colors hidden sm:block" />
            </div>
        </div>
    )
}

export default function StrategiesPage() {
    const { data: overview, isLoading } = useDashboardOverview()
    const triggerManualRun = useMutation(api.mutations.triggerManualRun)

    if (isLoading || !overview) {
        return <PageSkeleton count={3} height="h-20" spacing="space-y-4" />
    }

    const groupedByVenue = VENUE_APPS.map((app) => ({
        app,
        meta: VENUE_META[app],
        strategies: overview.strategies.filter((s) => s.app === app),
    })).filter((group) => group.strategies.length > 0)

    if (groupedByVenue.length === 0) {
        return (
            <div className="space-y-6">
                <div className="flex justify-end">
                    <Button asChild>
                        <Link href="/strategies/new">
                            <Plus className="h-4 w-4" />
                            New Strategy
                        </Link>
                    </Button>
                </div>
                <EmptyState
                    icon={Layers}
                    title="No strategies"
                    description="No strategies configured yet"
                />
            </div>
        )
    }

    return (
        <div className="space-y-6">
            <div className="flex justify-end">
                <Button asChild>
                    <Link href="/strategies/new">
                        <Plus className="h-4 w-4" />
                        New Strategy
                    </Link>
                </Button>
            </div>
            {groupedByVenue.map(({ app, meta, strategies }) => (
                <div key={app} className="space-y-3">
                    <div className="flex items-center gap-2">
                        <meta.icon className="h-4 w-4 text-muted-foreground" />
                        <h3 className="text-sm font-semibold">{meta.label}</h3>
                        <Badge variant="secondary" className="text-xs">
                            {strategies.length}
                        </Badge>
                    </div>
                    <div className="space-y-2">
                        {strategies.map((strategy) => (
                            <StrategyCard
                                key={strategy._id}
                                strategy={strategy}
                                onRun={() => {
                                    triggerManualRun({ strategyId: strategy._id })
                                        .then(() => toast.success(`Manual run triggered for ${strategy.name}`))
                                        .catch(() => toast.error("Failed to trigger run"))
                                }}
                            />
                        ))}
                    </div>
                </div>
            ))}
        </div>
    )
}

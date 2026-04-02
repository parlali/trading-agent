"use client"

import { useQuery } from "convex/react"
import { api } from "@valiq-trading/convex"
import { getNextCronFireMs } from "@valiq-trading/core"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { VenueBadge } from "@/components/venue-badge"
import { StatusDot } from "@/components/status-dot"
import { StatusBadge } from "@/components/status-badge"
import { PageSkeleton } from "@/components/page-skeleton"
import { EmptyState } from "@/components/empty-state"
import { formatRelativeTime } from "@/lib/format"
import { Calendar, ChevronRight, Clock, Zap } from "lucide-react"

type TriggerType = "cron" | "manual" | "callback"

interface ScheduleEntry {
    _id: string
    name: string
    app: string
    enabled: boolean
    schedule: string
    latestRun: {
        _id: string
        status: string
        trigger: TriggerType
        startedAt: number
        endedAt?: number
        error?: string
    } | null
    isRunning: boolean
    pendingCallback: {
        requestedMinutes: number
        firesAt: number
        scheduledByRunId: string
    } | null
}

function formatDuration(ms: number): string {
    const minutes = Math.floor(ms / 60_000)
    const hours = Math.floor(minutes / 60)
    if (hours > 0) {
        const remainingMinutes = minutes % 60
        return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
    }
    return `${minutes}m`
}

function formatCountdown(firesAt: number): string {
    const diff = firesAt - Date.now()
    if (diff <= 0) return "now"
    return formatDuration(diff)
}

function describeCron(expression: string): string {
    const parts = expression.trim().split(/\s+/)
    if (parts.length !== 5) return expression

    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts

    if (minute?.startsWith("*/") && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
        const interval = parseInt(minute.slice(2), 10)
        return `every ${interval}m`
    }

    if (minute !== "*" && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
        return `hourly at :${minute!.padStart(2, "0")}`
    }

    if (minute !== "*" && hour !== "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
        return `daily at ${hour}:${minute!.padStart(2, "0")} UTC`
    }

    return expression
}

function TriggerBadge({ trigger }: { trigger: TriggerType }) {
    switch (trigger) {
        case "callback":
            return (
                <Badge variant="outline" className="text-xs gap-1 border-chart-2/30 text-chart-2">
                    <Zap className="h-3 w-3" />
                    agent
                </Badge>
            )
        case "manual":
            return (
                <Badge variant="outline" className="text-xs gap-1">
                    manual
                </Badge>
            )
        default:
            return (
                <Badge variant="outline" className="text-xs gap-1 border-muted-foreground/30">
                    <Clock className="h-3 w-3" />
                    cron
                </Badge>
            )
    }
}

function NextFireInfo({ entry }: { entry: ScheduleEntry }) {
    const nextCronMs = entry.enabled ? getNextCronFireMs(entry.schedule) : null
    const callback = entry.pendingCallback

    if (entry.isRunning) {
        return (
            <div className="flex items-center gap-1.5">
                <StatusDot status="running" />
                <span className="text-xs text-signal-warning font-medium">running now</span>
            </div>
        )
    }

    if (!entry.enabled) {
        return <span className="text-xs text-muted-foreground">disabled</span>
    }

    if (callback && callback.firesAt > Date.now()) {
        const callbackCountdown = formatCountdown(callback.firesAt)
        const nextCronCountdown = nextCronMs ? formatDuration(nextCronMs) : null

        return (
            <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                    <Zap className="h-3 w-3 text-chart-2" />
                    <span className="text-xs font-medium">
                        in {callbackCountdown}
                    </span>
                    <Badge variant="outline" className="text-[10px] leading-tight border-chart-2/30 text-chart-2 px-1 py-0">
                        agent
                    </Badge>
                </div>
                {nextCronCountdown ? (
                    <div className="flex items-center gap-1.5">
                        <Clock className="h-3 w-3 text-muted-foreground" />
                        <span className="text-xs text-muted-foreground">
                            cron in {nextCronCountdown}
                        </span>
                    </div>
                ) : null}
            </div>
        )
    }

    if (nextCronMs) {
        return (
            <div className="flex items-center gap-1.5">
                <Clock className="h-3 w-3 text-muted-foreground" />
                <span className="text-xs font-medium">
                    in {formatDuration(nextCronMs)}
                </span>
            </div>
        )
    }

    return <span className="text-xs text-muted-foreground">--</span>
}

function ScheduleRow({ entry }: { entry: ScheduleEntry }) {
    return (
        <Link
            href={`/strategies/${entry._id}`}
            className="flex items-center justify-between rounded-lg border border-border-subtle p-3 sm:p-4 transition-colors hover:bg-muted/50 hover:border-border group"
        >
            <div className="flex items-center gap-3 min-w-0 flex-1">
                <StatusDot
                    status={
                        entry.isRunning
                            ? "running"
                            : entry.enabled
                                ? "healthy"
                                : "unhealthy"
                    }
                />
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <p className="text-sm font-medium truncate">{entry.name}</p>
                        <VenueBadge app={entry.app} />
                    </div>
                    <div className="flex items-center gap-3 mt-1">
                        <code className="text-xs text-muted-foreground font-mono">
                            {entry.schedule}
                        </code>
                        <span className="text-xs text-muted-foreground hidden sm:inline">
                            {describeCron(entry.schedule)}
                        </span>
                    </div>
                </div>
            </div>

            <div className="flex items-center gap-4 sm:gap-6 shrink-0 ml-3">
                <div className="text-right min-w-[80px] hidden sm:block">
                    <NextFireInfo entry={entry} />
                </div>

                <div className="text-right min-w-[90px]">
                    {entry.latestRun ? (
                        <div>
                            <div className="flex items-center gap-1.5 justify-end">
                                <StatusBadge
                                    status={entry.latestRun.status}
                                    category="run"
                                />
                                <TriggerBadge trigger={entry.latestRun.trigger} />
                            </div>
                            <p className="text-xs text-muted-foreground mt-1">
                                {formatRelativeTime(entry.latestRun.startedAt)}
                            </p>
                        </div>
                    ) : (
                        <span className="text-xs text-muted-foreground">never run</span>
                    )}
                </div>

                <ChevronRight className="h-4 w-4 text-muted-foreground/50 group-hover:text-muted-foreground transition-colors hidden sm:block" />
            </div>
        </Link>
    )
}

export default function SchedulePage() {
    const data = useQuery(api.queries.getScheduleOverview)

    if (data === undefined) {
        return <PageSkeleton count={4} height="h-20" spacing="space-y-3" />
    }

    if (data.length === 0) {
        return (
            <EmptyState
                icon={Calendar}
                title="No strategies"
                description="Create a strategy to see its schedule here"
            />
        )
    }

    const entries = data as ScheduleEntry[]
    const sorted = [...entries].sort((a, b) => {
        if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1

        const aNextMs = a.pendingCallback?.firesAt
            ? a.pendingCallback.firesAt - Date.now()
            : a.enabled ? getNextCronFireMs(a.schedule) : null
        const bNextMs = b.pendingCallback?.firesAt
            ? b.pendingCallback.firesAt - Date.now()
            : b.enabled ? getNextCronFireMs(b.schedule) : null

        if (aNextMs !== null && bNextMs !== null) return aNextMs - bNextMs
        if (aNextMs !== null) return -1
        if (bNextMs !== null) return 1
        return 0
    })

    const running = sorted.filter((e) => e.isRunning)
    const withCallback = sorted.filter(
        (e) => !e.isRunning && e.pendingCallback && e.pendingCallback.firesAt > Date.now()
    )
    const enabled = sorted.filter(
        (e) => !e.isRunning && e.enabled && !(e.pendingCallback && e.pendingCallback.firesAt > Date.now())
    )
    const disabled = sorted.filter((e) => !e.isRunning && !e.enabled)

    return (
        <div className="space-y-6">
            {running.length > 0 ? (
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="text-base flex items-center gap-2">
                            Running Now
                            <Badge variant="secondary" className="text-xs">
                                {running.length}
                            </Badge>
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        {running.map((entry) => (
                            <ScheduleRow key={entry._id} entry={entry} />
                        ))}
                    </CardContent>
                </Card>
            ) : null}

            {withCallback.length > 0 ? (
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="text-base flex items-center gap-2">
                            Agent Callbacks Pending
                            <Badge variant="secondary" className="text-xs">
                                {withCallback.length}
                            </Badge>
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        {withCallback.map((entry) => (
                            <ScheduleRow key={entry._id} entry={entry} />
                        ))}
                    </CardContent>
                </Card>
            ) : null}

            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2">
                        Scheduled
                        <Badge variant="secondary" className="text-xs">
                            {enabled.length}
                        </Badge>
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                    {enabled.length > 0 ? (
                        enabled.map((entry) => (
                            <ScheduleRow key={entry._id} entry={entry} />
                        ))
                    ) : (
                        <p className="text-sm text-muted-foreground py-2">No active schedules</p>
                    )}
                </CardContent>
            </Card>

            {disabled.length > 0 ? (
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="text-base flex items-center gap-2">
                            Disabled
                            <Badge variant="secondary" className="text-xs">
                                {disabled.length}
                            </Badge>
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        {disabled.map((entry) => (
                            <ScheduleRow key={entry._id} entry={entry} />
                        ))}
                    </CardContent>
                </Card>
            ) : null}
        </div>
    )
}

"use client"

import { use } from "react"
import { useQuery } from "convex/react"
import { api } from "@valiq-trading/convex"
import type { Id } from "@valiq-trading/convex"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { VenueBadge } from "@/components/venue-badge"
import { StatusDot } from "@/components/status-dot"
import { EmptyState } from "@/components/empty-state"
import { formatTimestamp } from "@/lib/format"
import { MessageSquare, ArrowRightLeft } from "lucide-react"

export default function RunDetailPage({
    params,
}: {
    params: Promise<{ id: string }>
}) {
    const { id } = use(params)
    const runId = id as Id<"strategy_runs">
    const overview = useQuery(api.queries.getDashboardOverview)
    const agentLogs = useQuery(api.queries.getAgentLogs, { runId })
    const tradeEvents = useQuery(api.queries.getTradeEvents, { runId })

    const run = overview?.recentRuns.find((r) => String(r._id) === id)
    const strategy = run
        ? overview?.strategies.find((s) => String(s._id) === String(run.strategyId))
        : null

    if (agentLogs === undefined || tradeEvents === undefined) {
        return (
            <div className="space-y-6">
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-64" />
            </div>
        )
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                <h2 className="text-lg font-semibold">
                    {strategy?.name ?? "Run Detail"}
                </h2>
                {run ? (
                    <>
                        <VenueBadge app={run.app} />
                        <Badge
                            variant={
                                run.status === "completed"
                                    ? "default"
                                    : run.status === "failed"
                                        ? "destructive"
                                        : "secondary"
                            }
                        >
                            {run.status}
                        </Badge>
                        <span className="text-sm text-muted-foreground">
                            {formatTimestamp(run.startedAt)}
                            {run.endedAt
                                ? ` (${Math.round((run.endedAt - run.startedAt) / 1000)}s)`
                                : ""}
                        </span>
                    </>
                ) : null}
            </div>

            {run?.summary ? (
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-base">Summary</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-sm">{run.summary}</p>
                    </CardContent>
                </Card>
            ) : null}

            {run?.error ? (
                <Card className="border-signal-danger/30">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-base text-signal-danger">Error</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <pre className="text-sm text-signal-danger font-mono whitespace-pre-wrap">
                            {run.error}
                        </pre>
                    </CardContent>
                </Card>
            ) : null}

            <Card>
                <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                        <MessageSquare className="h-4 w-4" />
                        Agent Trace ({agentLogs.length} messages)
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    {agentLogs.length === 0 ? (
                        <EmptyState
                            icon={MessageSquare}
                            title="No agent logs"
                            description="No reasoning trace recorded for this run"
                        />
                    ) : (
                        <div className="space-y-3 max-h-[600px] overflow-y-auto">
                            {agentLogs.map((log) => (
                                <div
                                    key={log._id}
                                    className="rounded-md border border-border-subtle p-3"
                                >
                                    <div className="flex items-center gap-2 mb-2">
                                        <Badge variant="outline" className="text-xs">
                                            {log.role}
                                        </Badge>
                                        {log.toolName ? (
                                            <Badge variant="secondary" className="text-xs font-mono">
                                                {log.toolName}
                                            </Badge>
                                        ) : null}
                                        <span className="text-xs text-muted-foreground ml-auto">
                                            #{log.sequence}
                                        </span>
                                    </div>
                                    <pre className="text-xs whitespace-pre-wrap font-mono bg-muted/50 rounded p-2 max-h-[200px] overflow-auto">
                                        {log.content}
                                    </pre>
                                    {log.toolInput ? (
                                        <details className="mt-2">
                                            <summary className="text-xs text-muted-foreground cursor-pointer">
                                                Tool Input
                                            </summary>
                                            <pre className="text-xs font-mono mt-1 bg-muted/50 rounded p-2 overflow-auto">
                                                {log.toolInput}
                                            </pre>
                                        </details>
                                    ) : null}
                                    {log.toolOutput ? (
                                        <details className="mt-2">
                                            <summary className="text-xs text-muted-foreground cursor-pointer">
                                                Tool Output
                                            </summary>
                                            <pre className="text-xs font-mono mt-1 bg-muted/50 rounded p-2 overflow-auto max-h-[200px]">
                                                {log.toolOutput}
                                            </pre>
                                        </details>
                                    ) : null}
                                </div>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                        <ArrowRightLeft className="h-4 w-4" />
                        Trade Events ({tradeEvents.length})
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    {tradeEvents.length === 0 ? (
                        <EmptyState
                            icon={ArrowRightLeft}
                            title="No trade events"
                            description="No order intents or executions for this run"
                        />
                    ) : (
                        <div className="space-y-2">
                            {tradeEvents.map((event) => {
                                let payload: Record<string, unknown> | null = null
                                try { payload = JSON.parse(event.payload) } catch { /* ignore */ }
                                return (
                                    <div
                                        key={event._id}
                                        className="flex items-start gap-3 rounded-md border border-border-subtle p-3"
                                    >
                                        <Badge
                                            variant={
                                                event.eventType === "filled"
                                                    ? "default"
                                                    : event.eventType === "rejected" || event.eventType === "cancelled"
                                                        ? "destructive"
                                                        : "secondary"
                                            }
                                            className="text-xs shrink-0"
                                        >
                                            {event.eventType}
                                        </Badge>
                                        <div className="min-w-0 flex-1">
                                            <p className="text-xs text-muted-foreground">
                                                {formatTimestamp(event.timestamp)}
                                            </p>
                                            {payload ? (
                                                <pre className="text-xs font-mono mt-1 bg-muted/50 rounded p-2 overflow-auto max-h-[150px]">
                                                    {JSON.stringify(payload, null, 2)}
                                                </pre>
                                            ) : null}
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    )
}

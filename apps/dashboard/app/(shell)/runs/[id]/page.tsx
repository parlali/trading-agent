"use client"

import { use, useState } from "react"
import { useQuery, useMutation } from "convex/react"
import { api } from "@valiq-trading/convex"
import type { Id } from "@valiq-trading/convex"
import { useDashboardOverview } from "@/hooks/use-dashboard-overview"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { VenueBadge } from "@/components/venue-badge"
import { StatusDot } from "@/components/status-dot"
import { StatusBadge } from "@/components/status-badge"
import { EmptyState } from "@/components/empty-state"
import { formatTimestamp } from "@/lib/format"
import { ArrowLeft, ArrowRightLeft, Loader2, MessageSquare, Square, Trash2 } from "lucide-react"
import { MarkdownContent } from "@/components/markdown-content"
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog"
import { toast } from "sonner"

export default function RunDetailPage({
    params,
}: {
    params: Promise<{ id: string }>
}) {
    const { id } = use(params)
    const runId = id as Id<"strategy_runs">
    const router = useRouter()
    const { data: overview } = useDashboardOverview()
    const agentLogs = useQuery(api.queries.getAgentLogs, { runId })
    const tradeEvents = useQuery(api.queries.getTradeEvents, { runId })
    const stopRunMutation = useMutation(api.mutations.stopRun)
    const deleteRunMutation = useMutation(api.mutations.deleteRun)

    const [stopping, setStopping] = useState(false)
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
    const [deleting, setDeleting] = useState(false)

    const run = overview?.recentRuns.find((r) => String(r._id) === id)
    const strategy = run
        ? overview?.strategies.find((s) => String(s._id) === String(run.strategyId))
        : null

    async function handleStop() {
        setStopping(true)
        try {
            await stopRunMutation({ runId })
            toast.success("Run stopped")
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to stop run")
        } finally {
            setStopping(false)
        }
    }

    async function handleDelete() {
        setDeleting(true)
        try {
            await deleteRunMutation({ runId })
            toast.success("Run deleted")
            setDeleteDialogOpen(false)
            router.push(strategy ? `/strategies/${strategy._id}` : "/runs")
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to delete run")
        } finally {
            setDeleting(false)
        }
    }

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
            <div className="space-y-3">
                <Button
                    variant="ghost"
                    size="sm"
                    asChild
                    className="text-muted-foreground -ml-2"
                >
                    <Link href={strategy ? `/strategies/${strategy._id}` : "/runs"}>
                        <ArrowLeft className="h-3.5 w-3.5" />
                        {strategy ? strategy.name : "Runs"}
                    </Link>
                </Button>
                <div className="flex flex-col gap-2">
                    <h2 className="text-lg font-semibold truncate">
                        {strategy?.name ?? "Run Detail"}
                    </h2>
                    {run ? (
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:flex-wrap">
                            <div className="flex items-center gap-2 flex-wrap">
                                <VenueBadge app={run.app} />
                                <StatusBadge
                                    status={run.status}
                                    category="run"
                                />
                                <span className="text-sm text-muted-foreground">
                                    {formatTimestamp(run.startedAt)}
                                    {run.endedAt
                                        ? ` (${Math.round((run.endedAt - run.startedAt) / 1000)}s)`
                                        : ""}
                                </span>
                            </div>
                            <div className="flex items-center gap-1.5 sm:ml-auto">
                                {run.status === "running" ? (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={handleStop}
                                        disabled={stopping}
                                    >
                                        {stopping
                                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                            : <Square className="h-3.5 w-3.5" />}
                                        Stop
                                    </Button>
                                ) : null}
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setDeleteDialogOpen(true)}
                                >
                                    <Trash2 className="h-3.5 w-3.5" />
                                    <span className="hidden sm:inline">Delete</span>
                                </Button>
                            </div>
                        </div>
                    ) : null}
                </div>
            </div>

            {run?.summary ? (
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-base">Summary</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <MarkdownContent content={run.summary} />
                    </CardContent>
                </Card>
            ) : null}

            {run?.error ? (
                <Card className="border-signal-danger/30">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-base text-signal-danger">Error</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <pre className="text-sm text-signal-danger font-mono whitespace-pre-wrap break-words max-w-full overflow-hidden">
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
                        <div className="space-y-3 max-h-[60vh] sm:max-h-[600px] overflow-y-auto">
                            {agentLogs.map((log) => (
                                <div
                                    key={log._id}
                                    className="rounded-md border border-border-subtle p-3"
                                >
                                    <div className="flex items-center gap-2 mb-2 flex-wrap">
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
                                    {log.role === "assistant" && log.content ? (
                                        <MarkdownContent content={log.content} />
                                    ) : (
                                        <pre className="text-xs whitespace-pre-wrap break-words font-mono bg-muted/50 rounded p-2 max-h-[200px] max-w-full overflow-auto">
                                            {log.content}
                                        </pre>
                                    )}
                                    {log.toolInput ? (
                                        <details className="mt-2">
                                            <summary className="text-xs text-muted-foreground cursor-pointer">
                                                Tool Input
                                            </summary>
                                            <pre className="text-xs font-mono mt-1 bg-muted/50 rounded p-2 overflow-auto break-words whitespace-pre-wrap">
                                                {log.toolInput}
                                            </pre>
                                        </details>
                                    ) : null}
                                    {log.toolOutput ? (
                                        <details className="mt-2">
                                            <summary className="text-xs text-muted-foreground cursor-pointer">
                                                Tool Output
                                            </summary>
                                            <pre className="text-xs font-mono mt-1 bg-muted/50 rounded p-2 overflow-auto max-h-[200px] break-words whitespace-pre-wrap">
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
                                        className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3 rounded-md border border-border-subtle p-3"
                                    >
                                        <StatusBadge
                                            status={event.eventType}
                                            category="event"
                                            className="text-xs shrink-0 w-fit"
                                        />
                                        <div className="min-w-0 flex-1">
                                            <p className="text-xs text-muted-foreground">
                                                {formatTimestamp(event.timestamp)}
                                            </p>
                                            {payload ? (
                                                <pre className="text-xs font-mono mt-1 bg-muted/50 rounded p-2 overflow-auto max-h-[150px] break-words whitespace-pre-wrap">
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

            <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Delete Run</DialogTitle>
                        <DialogDescription>
                            This will permanently delete this run and all its agent logs,
                            trade events, and order records. This cannot be undone.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setDeleteDialogOpen(false)}
                            disabled={deleting}
                        >
                            Cancel
                        </Button>
                        <Button
                            variant="destructive"
                            onClick={handleDelete}
                            disabled={deleting}
                        >
                            {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                            Delete
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}

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
import { ArrowLeft, ArrowRightLeft, BrainCircuit, Loader2, MessageSquare, Square, Trash2 } from "lucide-react"
import { MarkdownContent } from "@/components/markdown-content"
import { McpDiagnosticsList } from "@/components/mcp-diagnostics-list"
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog"
import { toast } from "sonner"

interface ExecutionErrorSummary {
    source?: string
    code?: string
    message: string
}

interface LlmDiagnosticsDisplay {
    fields: Array<{
        label: string
        value: string
    }>
    responseIds: string[]
    rateLimitSnapshotBefore?: unknown
    rateLimitSnapshotAfter?: unknown
}

export default function RunDetailPage({
    params,
}: {
    params: Promise<{ id: string }>
}) {
    const { id } = use(params)
    const runId = id as Id<"strategy_runs">
    const router = useRouter()
    const { data: overview } = useDashboardOverview()
    const run = useQuery(api.queries.getRunById, { runId })
    const agentLogs = useQuery(api.queries.getAgentLogs, { runId })
    const tradeEvents = useQuery(api.queries.getTradeEvents, { runId })
    const stopRunMutation = useMutation(api.mutations.stopRun)
    const deleteRunMutation = useMutation(api.mutations.deleteRun)

    const [stopping, setStopping] = useState(false)
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
    const [deleting, setDeleting] = useState(false)

    const strategy = run
        ? overview?.strategies.find((s) => String(s._id) === String(run.strategyId))
        : null
    const llmDiagnostics = run ? buildLlmDiagnostics(run as Record<string, unknown>) : null

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

    if (run === undefined || agentLogs === undefined || tradeEvents === undefined) {
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
                                {run.degradedResearch ? (
                                    <Badge variant="outline">degraded research</Badge>
                                ) : null}
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

            {run?.degradedResearch ? (
                <Card className="border-border-subtle">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-base">Degraded Research</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-1 text-sm">
                        <p>
                            This run completed under degraded research context.
                        </p>
                        <p className="text-muted-foreground">
                            Tool failures: {run.toolFailureCount ?? 0} • Retries: {run.toolRetryCount ?? 0}
                        </p>
                        {run.degradedReason ? (
                            <p className="text-muted-foreground break-words">
                                {run.degradedReason}
                            </p>
                        ) : null}
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

            {llmDiagnostics ? (
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-base flex items-center gap-2">
                            <BrainCircuit className="h-4 w-4" />
                            Model Provider
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3 text-sm">
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                            {llmDiagnostics.fields.map((field) => (
                                <div
                                    key={field.label}
                                    className="rounded-md border border-border-subtle p-3 min-w-0"
                                >
                                    <p className="text-xs text-muted-foreground">{field.label}</p>
                                    <p className="mt-1 font-mono text-xs break-words">{field.value}</p>
                                </div>
                            ))}
                        </div>
                        {llmDiagnostics.responseIds.length > 0 ? (
                            <details>
                                <summary className="text-xs text-muted-foreground cursor-pointer">
                                    Response IDs ({llmDiagnostics.responseIds.length})
                                </summary>
                                <pre className="text-xs font-mono mt-1 bg-muted/50 rounded p-2 overflow-auto max-h-[140px] break-words whitespace-pre-wrap">
                                    {JSON.stringify(llmDiagnostics.responseIds, null, 2)}
                                </pre>
                            </details>
                        ) : null}
                        {llmDiagnostics.rateLimitSnapshotBefore || llmDiagnostics.rateLimitSnapshotAfter ? (
                            <details>
                                <summary className="text-xs text-muted-foreground cursor-pointer">
                                    Rate Limits
                                </summary>
                                <pre className="text-xs font-mono mt-1 bg-muted/50 rounded p-2 overflow-auto max-h-[180px] break-words whitespace-pre-wrap">
                                    {JSON.stringify({
                                        before: llmDiagnostics.rateLimitSnapshotBefore,
                                        after: llmDiagnostics.rateLimitSnapshotAfter,
                                    }, null, 2)}
                                </pre>
                            </details>
                        ) : null}
                    </CardContent>
                </Card>
            ) : null}

            <McpDiagnosticsList diagnostics={run?.mcpToolDiagnostics ?? []} />

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
                                    {log.toolCalls ? (
                                        <details className="mt-2">
                                            <summary className="text-xs text-muted-foreground cursor-pointer">
                                                Tool Calls
                                            </summary>
                                            <pre className="text-xs font-mono mt-1 bg-muted/50 rounded p-2 overflow-auto max-h-[200px] break-words whitespace-pre-wrap">
                                                {log.toolCalls}
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
                                try {
                                    payload = JSON.parse(event.payload)
                                } catch {
                                    payload = null
                                }
                                const executionError = extractExecutionError(payload)
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
                                            {executionError ? (
                                                <div className="mt-2 rounded border border-signal-danger/30 bg-signal-danger/5 p-2 text-xs text-signal-danger">
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        {executionError.source ? (
                                                            <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
                                                                {executionError.source}
                                                            </Badge>
                                                        ) : null}
                                                        {executionError.code ? (
                                                            <Badge variant="outline" className="text-[10px] font-mono">
                                                                {executionError.code}
                                                            </Badge>
                                                        ) : null}
                                                    </div>
                                                    <p className="mt-1 whitespace-pre-wrap break-words">
                                                        {executionError.message}
                                                    </p>
                                                </div>
                                            ) : null}
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

function buildLlmDiagnostics(run: Record<string, unknown>): LlmDiagnosticsDisplay | null {
    const provider = readString(run.llmProvider) ?? (readStringArray(run.openRouterResponseIds).length > 0 ? "openrouter" : undefined)
    const model = readString(run.llmModel)
    const responseIds = readStringArray(run.llmResponseIds)
    const legacyOpenRouterResponseIds = readStringArray(run.openRouterResponseIds)
    const displayedResponseIds = responseIds.length > 0 ? responseIds : legacyOpenRouterResponseIds
    const fields: LlmDiagnosticsDisplay["fields"] = []

    addDiagnosticField(fields, "Provider", provider)
    addDiagnosticField(fields, "Model", model)
    addDiagnosticField(fields, "Auth", readString(run.llmAuthMode))
    addDiagnosticField(fields, "Billing", readString(run.llmBillingMode))
    addDiagnosticField(fields, "Prompt Tokens", readNumberLabel(run.promptTokens))
    addDiagnosticField(fields, "Completion Tokens", readNumberLabel(run.completionTokens))
    addDiagnosticField(fields, "Reasoning Tokens", readNumberLabel(run.reasoningTokens))
    addDiagnosticField(fields, "Cost", readCostLabel(run.llmCost))
    addDiagnosticField(fields, "Tool Calls", readNumberLabel(run.toolCallCount))
    addDiagnosticField(fields, "Codex Thread", readString(run.codexThreadId))
    addDiagnosticField(fields, "Codex Turns", readStringArray(run.codexTurnIds).join(", "))

    if (fields.length === 0 && displayedResponseIds.length === 0) {
        return null
    }

    return {
        fields,
        responseIds: displayedResponseIds,
        rateLimitSnapshotBefore: run.llmRateLimitSnapshotBefore,
        rateLimitSnapshotAfter: run.llmRateLimitSnapshotAfter,
    }
}

function addDiagnosticField(
    fields: LlmDiagnosticsDisplay["fields"],
    label: string,
    value: string | undefined
): void {
    if (!value) {
        return
    }

    fields.push({ label, value })
}

function readString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0
        ? value
        : undefined
}

function readStringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        : []
}

function readNumberLabel(value: unknown): string | undefined {
    return typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : undefined
}

function readCostLabel(value: unknown): string | undefined {
    return typeof value === "number" && Number.isFinite(value) && value > 0
        ? `$${value.toFixed(6)}`
        : undefined
}

function extractExecutionError(payload: Record<string, unknown> | null): ExecutionErrorSummary | null {
    if (!payload) {
        return null
    }

    const candidate = isRecord(payload.result)
        ? payload.result
        : payload
    const errorDetail = isRecord(candidate.errorDetail)
        ? candidate.errorDetail
        : null

    if (errorDetail && typeof errorDetail.message === "string") {
        return {
            source: typeof errorDetail.source === "string" ? errorDetail.source : undefined,
            code: typeof errorDetail.code === "string" ? errorDetail.code : undefined,
            message: errorDetail.message,
        }
    }

    if (typeof candidate.error === "string" && candidate.error.trim()) {
        return { message: candidate.error }
    }

    return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object"
}

"use client";
import { use, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@valiq-trading/convex";
import { useStrategy } from "@/hooks/use-strategy";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { VenueBadge } from "@/components/venue-badge";
import { StatusDot } from "@/components/status-dot";
import { EmptyState } from "@/components/empty-state";
import { DeleteStrategyDialog } from "@/components/delete-strategy-dialog";
import { formatTimestamp } from "@/lib/format";
import { ArrowLeft, History, Pencil, Play, Trash2 } from "lucide-react";
import { toast } from "sonner";
export default function StrategyDetailPage({ params, }) {
    const { id } = use(params);
    const router = useRouter();
    const { data: strategy, isLoading, notFound } = useStrategy(id);
    const runs = useQuery(api.queries.getRunHistory, {
        strategyId: id,
        limit: 20,
    });
    const upsertStrategy = useMutation(api.mutations.upsertStrategy);
    const triggerManualRun = useMutation(api.mutations.triggerManualRun);
    const [deleteOpen, setDeleteOpen] = useState(false);
    if (isLoading || runs === undefined) {
        return (<div className="space-y-6">
                <Skeleton className="h-8 w-48"/>
                <Skeleton className="h-48"/>
            </div>);
    }
    if (notFound || !strategy) {
        return (<div className="flex items-center justify-center py-12">
                <p className="text-sm text-muted-foreground">Strategy not found</p>
            </div>);
    }
    const isRunning = runs.some((r) => r.status === "running");
    function handleToggleEnabled(checked) {
        upsertStrategy({
            id: strategy._id,
            app: strategy.app,
            name: strategy.name,
            enabled: checked,
            schedule: strategy.schedule,
            policy: strategy.policy,
            context: strategy.context,
        })
            .then(() => toast.success(checked ? "Strategy enabled" : "Strategy disabled"))
            .catch(() => toast.error("Failed to update strategy"));
    }
    function handleManualRun() {
        triggerManualRun({ strategyId: strategy._id })
            .then(() => toast.success(`Manual run triggered for ${strategy.name}`))
            .catch(() => toast.error("Failed to trigger run"));
    }
    return (<div className="space-y-6">
            <div className="space-y-4">
                <Button variant="ghost" size="sm" asChild className="text-muted-foreground -ml-2">
                    <Link href="/strategies">
                        <ArrowLeft className="h-3.5 w-3.5"/>
                        Strategies
                    </Link>
                </Button>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-2 min-w-0 flex-wrap">
                        <h2 className="text-lg font-semibold truncate">{strategy.name}</h2>
                        <VenueBadge app={strategy.app}/>
                        <Badge variant={strategy.enabled ? "default" : "secondary"}>
                            {strategy.enabled ? "enabled" : "disabled"}
                        </Badge>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 flex-wrap">
                        <Button variant="default" size="sm" disabled={!strategy.enabled || isRunning} onClick={handleManualRun}>
                            <Play className="h-3 w-3"/>
                            {isRunning ? "Running..." : "Run Now"}
                        </Button>
                        <Button variant="outline" size="sm" asChild>
                            <Link href={`/strategies/${id}/edit`}>
                                <Pencil className="h-3 w-3"/>
                                <span className="hidden sm:inline">Edit</span>
                            </Link>
                        </Button>
                        <Button variant="outline" size="sm" className="text-signal-danger hover:text-signal-danger" onClick={() => setDeleteOpen(true)}>
                            <Trash2 className="h-3 w-3"/>
                            <span className="hidden sm:inline">Delete</span>
                        </Button>
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Configuration</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="flex items-center justify-between">
                            <Label className="text-sm">Enabled</Label>
                            <Switch checked={strategy.enabled} onCheckedChange={handleToggleEnabled}/>
                        </div>
                        <div>
                            <p className="text-xs text-muted-foreground mb-1">Schedule</p>
                            <code className="text-sm font-mono">{strategy.schedule}</code>
                        </div>
                        <div>
                            <p className="text-xs text-muted-foreground mb-1">Policy</p>
                            <pre className="text-xs font-mono bg-muted rounded-md p-3 overflow-auto max-h-[300px] max-w-full">
                                {JSON.stringify(strategy.policy, null, 2)}
                            </pre>
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Context</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <pre className="text-sm whitespace-pre-wrap break-words bg-muted rounded-md p-3 overflow-auto max-h-[400px] max-w-full">
                            {strategy.context || "(empty)"}
                        </pre>
                    </CardContent>
                </Card>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Run History</CardTitle>
                </CardHeader>
                <CardContent>
                    {runs.length === 0 ? (<EmptyState icon={History} title="No runs" description="This strategy has not been run yet"/>) : (<div className="space-y-2">
                            {runs.map((run) => (<Link key={run._id} href={`/runs/${run._id}`} className="flex items-center justify-between rounded-lg border border-border-subtle p-3 transition-colors hover:bg-muted/50 hover:border-border group">
                                    <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
                                        <StatusDot status={run.status}/>
                                        <div className="min-w-0">
                                            <p className="text-sm font-medium">
                                                {formatTimestamp(run.startedAt)}
                                            </p>
                                            {run.summary ? (<p className="text-xs text-muted-foreground truncate max-w-[140px] sm:max-w-[300px]">
                                                    {run.summary}
                                                </p>) : null}
                                            {run.error ? (<p className="text-xs text-signal-danger truncate max-w-[140px] sm:max-w-[300px]">
                                                    {run.error}
                                                </p>) : null}
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2 sm:gap-3 shrink-0 ml-2">
                                        <Badge variant={run.status === "completed"
                    ? "default"
                    : run.status === "failed"
                        ? "destructive"
                        : "secondary"} className="text-xs">
                                            {run.status}
                                        </Badge>
                                        {run.endedAt ? (<span className="text-xs text-muted-foreground tabular-nums font-mono hidden sm:inline">
                                                {Math.round((run.endedAt - run.startedAt) / 1000)}s
                                            </span>) : null}
                                    </div>
                                </Link>))}
                        </div>)}
                </CardContent>
            </Card>

            <DeleteStrategyDialog open={deleteOpen} onOpenChange={setDeleteOpen} strategyId={strategy._id} strategyName={strategy.name} onDeleted={() => router.push("/strategies")}/>
        </div>);
}

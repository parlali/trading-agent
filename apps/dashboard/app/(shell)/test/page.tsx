"use client"

import { useState, useCallback } from "react"
import { useAction, useQuery } from "convex/react"
import { api } from "@valiq-trading/convex"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { VENUE_META } from "@/lib/constants"
import {
    Loader2,
    Play,
    CheckCircle2,
    XCircle,
    Server,
    BarChart3,
    TrendingUp,
    Coins,
    Sparkles,
    ChevronDown,
    ChevronRight,
} from "lucide-react"

type StepResult = {
    name: string
    ok: boolean
    data?: unknown
    error?: string
}

type TestResult = {
    ok: boolean
    error?: string
    steps?: StepResult[]
    data?: unknown
}

type TestStatus = "idle" | "running" | "success" | "error"

function StepRow({ step }: { step: StepResult }) {
    const [expanded, setExpanded] = useState(false)
    const hasData = step.data !== undefined && step.data !== null

    return (
        <div className="border-b border-border-subtle last:border-b-0">
            <button
                type="button"
                onClick={() => hasData && setExpanded(!expanded)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs ${hasData ? "cursor-pointer hover:bg-muted/50" : "cursor-default"}`}
            >
                {step.ok ? (
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-signal-healthy" />
                ) : (
                    <XCircle className="h-3.5 w-3.5 shrink-0 text-signal-danger" />
                )}
                <span className="font-medium">{step.name}</span>
                {step.error && !step.ok ? (
                    <span className="ml-auto truncate text-signal-danger max-w-[60%]">{step.error}</span>
                ) : null}
                {hasData ? (
                    expanded ? (
                        <ChevronDown className="ml-auto h-3 w-3 shrink-0 text-muted-foreground" />
                    ) : (
                        <ChevronRight className="ml-auto h-3 w-3 shrink-0 text-muted-foreground" />
                    )
                ) : null}
            </button>
            {expanded && hasData ? (
                <div className="border-t border-border-subtle bg-muted/30 px-3 py-2 overflow-hidden">
                    <div className="max-h-64 overflow-y-auto">
                        <pre className="font-mono text-xs text-muted-foreground whitespace-pre-wrap break-all">
                            {JSON.stringify(step.data, null, 2)}
                        </pre>
                    </div>
                </div>
            ) : null}
        </div>
    )
}

function TestCard({
    title,
    description,
    icon: Icon,
    onRun,
    children,
}: {
    title: string
    description: string
    icon: React.ComponentType<{ className?: string }>
    onRun: () => Promise<TestResult>
    children?: React.ReactNode
}) {
    const [status, setStatus] = useState<TestStatus>("idle")
    const [result, setResult] = useState<TestResult | null>(null)
    const [elapsed, setElapsed] = useState<number | null>(null)

    const handleRun = useCallback(async () => {
        setStatus("running")
        setResult(null)
        setElapsed(null)
        const start = Date.now()

        try {
            const res = await onRun()
            setElapsed(Date.now() - start)
            setResult(res)
            setStatus(res.ok ? "success" : "error")
        } catch (e: unknown) {
            setElapsed(Date.now() - start)
            const message = e instanceof Error ? e.message : String(e)
            setResult({ ok: false, error: message })
            setStatus("error")
        }
    }, [onRun])

    return (
        <Card>
            <CardHeader>
                <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
                            <Icon className="h-4 w-4 text-muted-foreground" />
                        </div>
                        <div>
                            <CardTitle className="text-sm">{title}</CardTitle>
                            <CardDescription className="text-xs">{description}</CardDescription>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        {status !== "idle" && status !== "running" ? (
                            <Badge
                                variant={status === "success" ? "secondary" : "destructive"}
                                className="text-[10px]"
                            >
                                {status === "success" ? "OK" : "FAIL"}
                                {elapsed !== null ? ` (${(elapsed / 1000).toFixed(1)}s)` : ""}
                            </Badge>
                        ) : null}
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={handleRun}
                            disabled={status === "running"}
                        >
                            {status === "running" ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <Play className="h-3.5 w-3.5" />
                            )}
                            {status === "running" ? "Testing..." : "Run Test"}
                        </Button>
                    </div>
                </div>
            </CardHeader>
            {children ? (
                <CardContent className="pt-0 pb-3">
                    {children}
                </CardContent>
            ) : null}
            {result ? (
                <CardContent className="pt-0">
                    {result.error && !result.steps?.length ? (
                        <div className="rounded-md bg-signal-danger/10 px-3 py-2 text-xs text-signal-danger">
                            {result.error}
                        </div>
                    ) : null}
                    {result.steps && result.steps.length > 0 ? (
                        <div className="rounded-md border border-border-subtle overflow-hidden">
                            {result.steps.map((step, i) => (
                                <StepRow key={`${step.name}-${i}`} step={step} />
                            ))}
                        </div>
                    ) : null}
                </CardContent>
            ) : null}
        </Card>
    )
}

export default function TestPage() {
    const testBackend = useAction(api.connectionTests.testBackendHealth)
    const testMT5 = useAction(api.connectionTests.testMT5Connection)
    const testAlpaca = useAction(api.connectionTests.testAlpacaConnection)
    const testPolymarket = useAction(api.connectionTests.testPolymarketConnection)
    const testOKX = useAction(api.connectionTests.testOKXConnection)
    const testMcp = useAction(api.connectionTests.testMcpConnection)
    const accounts = useQuery(api.queries.getAccounts, {})

    const venueTests = {
        "mt5": { run: testMT5, icon: BarChart3, description: "Runtime-aligned worker health, MT5 account, positions, and working orders" },
        "alpaca-options": { run: testAlpaca, icon: TrendingUp, description: "Runtime-aligned Alpaca trading account, positions, and market-data host" },
        "polymarket": { run: testPolymarket, icon: Coins, description: "Runtime-aligned signer and funder config, authenticated startup path, account state, positions, and open bets" },
        "okx-swap": { run: testOKX, icon: TrendingUp, description: "Runtime-aligned OKX account config, balance, positions, and market data" },
    } as const

    return (
        <div className="space-y-4">
            <div className="space-y-1">
                <p className="text-xs text-muted-foreground">
                    Test each external connection independently. Each test now reuses the same
                    runtime credential resolution and client or adapter path that scheduled runs use.
                </p>
            </div>

            <div className="grid gap-4">
                <TestCard
                    title="Backend"
                    description="Health endpoint on the consolidated backend runtime"
                    icon={Server}
                    onRun={() => testBackend()}
                />

                {accounts === undefined ? (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Loading account pool...
                    </div>
                ) : accounts.length === 0 ? (
                    <div className="rounded-md border border-border-subtle px-3 py-2 text-xs text-muted-foreground">
                        No accounts configured in the account pool. Venue connection tests run per account.
                    </div>
                ) : (
                    (Object.keys(venueTests) as Array<keyof typeof venueTests>).flatMap((app) =>
                        accounts
                            .filter((account) => account.app === app)
                            .map((account) => {
                                const venueTest = venueTests[app]
                                return (
                                    <TestCard
                                        key={`${app}:${account.accountId}`}
                                        title={`${VENUE_META[app].label} - ${account.label}`}
                                        description={`${account.accountId} (${account.credentialEnvPrefix}). ${venueTest.description}`}
                                        icon={venueTest.icon}
                                        onRun={() => venueTest.run({ accountId: account.accountId })}
                                    />
                                )
                            })
                    )
                )}

                <TestCard
                    title="MCP Research"
                    description="Generic MCP endpoint: initialize and list configured research/data tools"
                    icon={Sparkles}
                    onRun={() => testMcp({})}
                />
            </div>
        </div>
    )
}

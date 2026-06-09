"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useAuthToken } from "@convex-dev/auth/react"
import { toast } from "sonner"
import { CheckCircle2, Copy, ExternalLink, Loader2, LogIn, XCircle } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type CodexOAuthStatus =
    | "idle"
    | "awaiting_redirect"
    | "submitting"
    | "complete"
    | "failed"
    | "cancelled"
    | "expired"

type CodexOAuthSnapshot = {
    status: CodexOAuthStatus
    ready: boolean
    authUrl: string | null
    codexHome: string
    authFilePath: string
    accountId: string | null
    lastRefresh: string | null
    startedAt: string | null
    updatedAt: string | null
    completedAt: string | null
    message: string
}

export function CodexOAuthPanel() {
    const authToken = useAuthToken()
    const [snapshot, setSnapshot] = useState<CodexOAuthSnapshot | null>(null)
    const [redirectUrl, setRedirectUrl] = useState("")
    const [loadingAction, setLoadingAction] = useState<CodexOAuthStatus | "refresh" | null>(null)

    const canSubmit = snapshot?.status === "awaiting_redirect" && redirectUrl.trim().length > 0
    const isBusy = loadingAction !== null || snapshot?.status === "submitting"
    const statusVariant = snapshot?.ready ? "default" : snapshot?.status === "failed" ? "destructive" : "secondary"

    const requestCodexOAuth = useCallback(async (
        action: "status" | "start" | "submit" | "cancel",
        payload?: Record<string, unknown>
    ): Promise<CodexOAuthSnapshot> => {
        if (!authToken) {
            throw new Error("Dashboard authentication is not ready")
        }

        const response = await fetch(`/api/codex-oauth?action=${action}`, {
            method: action === "status" ? "GET" : "POST",
            headers: {
                "authorization": `Bearer ${authToken}`,
                ...(payload ? { "content-type": "application/json" } : {}),
            },
            body: payload ? JSON.stringify(payload) : undefined,
            cache: "no-store",
        })
        const body = await response.json() as unknown
        const data = readRecord(body)

        if (!response.ok) {
            throw new Error(readString(data.error) ?? "Codex OAuth request failed")
        }

        return data as CodexOAuthSnapshot
    }, [authToken])

    const refreshStatus = useCallback(async () => {
        if (!authToken) {
            return
        }

        setLoadingAction((current) => current ?? "refresh")
        try {
            setSnapshot(await requestCodexOAuth("status"))
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to read Codex login status")
        } finally {
            setLoadingAction((current) => current === "refresh" ? null : current)
        }
    }, [authToken, requestCodexOAuth])

    useEffect(() => {
        void refreshStatus()
    }, [refreshStatus])

    useEffect(() => {
        if (!snapshot || (snapshot.status !== "awaiting_redirect" && snapshot.status !== "submitting")) {
            return
        }

        const timer = window.setInterval(() => {
            void refreshStatus()
        }, 3000)

        return () => window.clearInterval(timer)
    }, [refreshStatus, snapshot])

    async function startLogin() {
        setLoadingAction("awaiting_redirect")
        try {
            const next = await requestCodexOAuth("start")
            setSnapshot(next)
            if (next.authUrl) {
                window.open(next.authUrl, "_blank", "noopener,noreferrer")
            }
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to start Codex login")
        } finally {
            setLoadingAction(null)
        }
    }

    async function submitRedirectUrl() {
        setLoadingAction("submitting")
        try {
            const next = await requestCodexOAuth("submit", {
                redirectUrl,
            })
            setSnapshot(next)
            setRedirectUrl("")
            toast.success("Codex ChatGPT login connected")
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to complete Codex login")
            await refreshStatus()
        } finally {
            setLoadingAction(null)
        }
    }

    async function cancelLogin() {
        setLoadingAction("cancelled")
        try {
            setSnapshot(await requestCodexOAuth("cancel"))
            setRedirectUrl("")
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to cancel Codex login")
        } finally {
            setLoadingAction(null)
        }
    }

    async function copyAuthUrl() {
        if (!snapshot?.authUrl) {
            return
        }

        await navigator.clipboard.writeText(snapshot.authUrl)
        toast.success("Codex login link copied")
    }

    const accountLabel = useMemo(() => {
        if (!snapshot?.accountId) {
            return null
        }

        return snapshot.accountId.length > 14
            ? `${snapshot.accountId.slice(0, 8)}...${snapshot.accountId.slice(-4)}`
            : snapshot.accountId
    }, [snapshot?.accountId])

    return (
        <Card>
            <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <CardTitle className="text-base">Codex ChatGPT Login</CardTitle>
                </div>
                <Badge variant={statusVariant} className="w-fit">
                    {snapshot?.ready ? "active" : snapshot?.status ?? "loading"}
                </Badge>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <StatusCell label="Status" value={snapshot?.message ?? "Loading Codex login status"} />
                    <StatusCell label="Account" value={accountLabel ?? "Not connected"} />
                    <StatusCell label="Last Refresh" value={formatStatusTime(snapshot?.lastRefresh)} />
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    <Button type="button" onClick={startLogin} disabled={!authToken || isBusy}>
                        {loadingAction === "awaiting_redirect" ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <LogIn className="h-4 w-4" />
                        )}
                        Sign in with ChatGPT
                    </Button>
                    {snapshot?.authUrl ? (
                        <>
                            <Button type="button" variant="outline" onClick={() => window.open(snapshot.authUrl!, "_blank", "noopener,noreferrer")}>
                                <ExternalLink className="h-4 w-4" />
                                Open Login
                            </Button>
                            <Button type="button" variant="outline" onClick={copyAuthUrl}>
                                <Copy className="h-4 w-4" />
                                Copy Link
                            </Button>
                            <Button type="button" variant="outline" onClick={cancelLogin} disabled={isBusy}>
                                <XCircle className="h-4 w-4" />
                                Cancel
                            </Button>
                        </>
                    ) : null}
                    {snapshot?.ready ? (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Scheduler gate ready
                        </span>
                    ) : null}
                </div>

                {snapshot?.authUrl ? (
                    <div className="space-y-2">
                        <Label htmlFor="codex-redirect-url" className="text-sm">
                            Redirect URL
                        </Label>
                        <div className="flex flex-col gap-2 sm:flex-row">
                            <Input
                                id="codex-redirect-url"
                                value={redirectUrl}
                                onChange={(event) => setRedirectUrl(event.target.value)}
                                placeholder="http://localhost:1455/auth/callback?code=..."
                                className="font-mono text-xs"
                            />
                            <Button type="button" onClick={submitRedirectUrl} disabled={!canSubmit || isBusy}>
                                {loadingAction === "submitting" ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                    <CheckCircle2 className="h-4 w-4" />
                                )}
                                Connect
                            </Button>
                        </div>
                    </div>
                ) : null}
            </CardContent>
        </Card>
    )
}

function StatusCell({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-1 break-words text-sm font-medium">{value}</p>
        </div>
    )
}

function formatStatusTime(value: string | null | undefined): string {
    if (!value) {
        return "Never"
    }

    const timestamp = Date.parse(value)
    if (Number.isNaN(timestamp)) {
        return value
    }

    return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(timestamp)
}

function readRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {}
}

function readString(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value : null
}

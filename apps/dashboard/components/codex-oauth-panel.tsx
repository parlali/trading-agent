"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useAuthToken } from "@convex-dev/auth/react"
import { toast } from "sonner"
import { CheckCircle2, Copy, ExternalLink, Loader2, LogIn } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

type CodexOAuthStatus =
    | "idle"
    | "starting"
    | "awaiting_device"
    | "complete"
    | "failed"
    | "expired"

type CodexOAuthSnapshot = {
    status: CodexOAuthStatus
    ready: boolean
    deviceVerificationUrl: string | null
    userCode: string | null
    codexHome: string
    authFilePath: string
    accountId: string | null
    lastRefresh: string | null
    startedAt: string | null
    updatedAt: string | null
    expiresAt: string | null
    message: string
}

export function CodexOAuthPanel() {
    const authToken = useAuthToken()
    const [snapshot, setSnapshot] = useState<CodexOAuthSnapshot | null>(null)
    const [loadingAction, setLoadingAction] = useState<"start" | "refresh" | null>(null)

    const isBusy = loadingAction !== null
    const loginActive = snapshot?.status === "starting" || snapshot?.status === "awaiting_device"
    const statusVariant = snapshot?.ready
        ? "default"
        : snapshot?.status === "failed" || snapshot?.status === "expired"
            ? "destructive"
            : "secondary"

    const requestCodexOAuth = useCallback(async (
        action: "status" | "start",
        options: { force?: boolean } = {}
    ): Promise<CodexOAuthSnapshot> => {
        if (!authToken) {
            throw new Error("Dashboard authentication is not ready")
        }

        const params = new URLSearchParams({ action })
        if (options.force) {
            params.set("force", "1")
        }

        const response = await fetch(`/api/codex-oauth?${params.toString()}`, {
            method: action === "status" ? "GET" : "POST",
            headers: {
                "authorization": `Bearer ${authToken}`,
            },
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
        if (!loginActive) {
            return
        }

        const timer = window.setInterval(() => {
            void refreshStatus()
        }, 3000)

        return () => window.clearInterval(timer)
    }, [loginActive, refreshStatus])

    async function startLogin(force = false) {
        setLoadingAction("start")
        try {
            const next = await requestCodexOAuth("start", { force })
            setSnapshot(next)
            if (next.deviceVerificationUrl) {
                window.open(next.deviceVerificationUrl, "_blank", "noopener,noreferrer")
            }
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to start Codex login")
        } finally {
            setLoadingAction(null)
        }
    }

    async function copyUserCode() {
        if (!snapshot?.userCode) {
            return
        }

        await navigator.clipboard.writeText(snapshot.userCode)
        toast.success("Codex login code copied")
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
                    <Button type="button" onClick={() => startLogin(snapshot?.ready === true)} disabled={!authToken || isBusy || loginActive}>
                        {loadingAction === "start" ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <LogIn className="h-4 w-4" />
                        )}
                        {snapshot?.ready ? "Re-authenticate ChatGPT" : "Sign in with ChatGPT"}
                    </Button>
                    {snapshot?.deviceVerificationUrl ? (
                        <Button type="button" variant="outline" onClick={() => window.open(snapshot.deviceVerificationUrl!, "_blank", "noopener,noreferrer")}>
                            <ExternalLink className="h-4 w-4" />
                            Open ChatGPT
                        </Button>
                    ) : null}
                    {snapshot?.userCode ? (
                        <Button type="button" variant="outline" onClick={copyUserCode}>
                            <Copy className="h-4 w-4" />
                            Copy Code
                        </Button>
                    ) : null}
                    {snapshot?.ready ? (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Scheduler gate ready
                        </span>
                    ) : null}
                </div>

                {snapshot?.status === "awaiting_device" || snapshot?.status === "starting" ? (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                        <StatusCell label="Device Code" value={snapshot.userCode ?? "Waiting"} />
                        <StatusCell label="Expires" value={formatStatusTime(snapshot.expiresAt)} />
                        <StatusCell label="Started" value={formatStatusTime(snapshot.startedAt)} />
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

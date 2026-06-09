"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useAuthToken } from "@convex-dev/auth/react"
import { toast } from "sonner"
import { CheckCircle2, Loader2, LogIn } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

type CodexOAuthStatus =
    | "idle"
    | "complete"

type CodexOAuthSnapshot = {
    status: CodexOAuthStatus
    ready: boolean
    codexHome: string
    authFilePath: string
    accountId: string | null
    lastRefresh: string | null
    message: string
}

export function CodexOAuthPanel() {
    const authToken = useAuthToken()
    const [snapshot, setSnapshot] = useState<CodexOAuthSnapshot | null>(null)
    const [loadingAction, setLoadingAction] = useState<"start" | "refresh" | null>(null)

    const isBusy = loadingAction !== null
    const statusVariant = snapshot?.ready ? "default" : "secondary"

    const requestCodexOAuth = useCallback(async (
        action: "status" | "start"
    ): Promise<CodexOAuthSnapshot> => {
        if (!authToken) {
            throw new Error("Dashboard authentication is not ready")
        }

        const response = await fetch(`/api/codex-oauth?action=${action}`, {
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

    async function startLogin() {
        setLoadingAction("start")
        try {
            setSnapshot(await requestCodexOAuth("start"))
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to start Codex login")
        } finally {
            setLoadingAction(null)
        }
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
                    <Button type="button" onClick={startLogin} disabled={!authToken || isBusy || snapshot?.ready}>
                        {loadingAction === "start" ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <LogIn className="h-4 w-4" />
                        )}
                        Sign in with ChatGPT
                    </Button>
                    {snapshot?.ready ? (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Scheduler gate ready
                        </span>
                    ) : null}
                </div>
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

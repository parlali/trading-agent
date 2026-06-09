import { NextResponse } from "next/server"
import { ConvexHttpClient } from "convex/browser"
import { api } from "@valiq-trading/convex"

export type CodexOAuthAction = "status" | "start" | "submit" | "cancel"

export async function requireDashboardUser(request: Request): Promise<void> {
    const token = readBearerToken(request.headers.get("authorization"))
    if (!token) {
        throw new Error("Dashboard authentication required")
    }

    const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL
    if (!convexUrl) {
        throw new Error("NEXT_PUBLIC_CONVEX_URL is not configured")
    }

    const client = new ConvexHttpClient(convexUrl)
    client.setAuth(token)
    await client.query(api.queries.assertDashboardUser, {})
}

export async function proxyCodexOAuthRequest(
    action: CodexOAuthAction,
    payload: Record<string, unknown> | null
): Promise<Response> {
    const serviceToken = process.env.BACKEND_SERVICE_TOKEN?.trim()
    if (!serviceToken) {
        throw new Error("BACKEND_SERVICE_TOKEN is not configured for dashboard Codex OAuth proxy")
    }

    const target = new URL(`/codex/oauth/${action}`, readBackendUrl())
    const response = await fetch(target, {
        method: action === "status" ? "GET" : "POST",
        headers: {
            "authorization": `Bearer ${serviceToken}`,
            "accept": "application/json",
            ...(payload ? { "content-type": "application/json" } : {}),
        },
        body: payload ? JSON.stringify(payload) : undefined,
        cache: "no-store",
    })
    const contentType = response.headers.get("content-type") ?? "application/json"
    const body = await response.text()

    return new Response(body, {
        status: response.status,
        headers: {
            "content-type": contentType,
            "cache-control": "no-store",
        },
    })
}

export function buildDashboardCodexCallbackUrl(request: Request): string {
    return new URL("/api/codex-oauth/callback", readDashboardOrigin(request)).toString()
}

export function readDashboardOrigin(request: Request): string {
    const forwardedHost = readFirstHeaderValue(request.headers.get("x-forwarded-host"))
    const host = forwardedHost ?? readFirstHeaderValue(request.headers.get("host"))
    if (host) {
        const forwardedProto = readFirstHeaderValue(request.headers.get("x-forwarded-proto"))
            ?? new URL(request.url).protocol.replace(":", "")
        const headerOrigin = parseOrigin(`${forwardedProto}://${host}`)
        if (headerOrigin) {
            return headerOrigin
        }
    }

    const origin = parseOrigin(readFirstHeaderValue(request.headers.get("origin")))
    if (origin) {
        return origin
    }

    return new URL(request.url).origin
}

export function readAction(value: string | null): CodexOAuthAction {
    if (value === "status" || value === "start" || value === "submit" || value === "cancel") {
        return value
    }

    throw new Error("Invalid Codex OAuth action")
}

export async function readJsonRecord(request: Request): Promise<Record<string, unknown>> {
    try {
        const value = await request.json() as unknown
        return readRecord(value)
    } catch {
        return {}
    }
}

export function redirectToIntegrations(request: Request, status: "complete" | "failed"): Response {
    const target = new URL("/integrations", readDashboardOrigin(request))
    target.searchParams.set("codex_oauth", status)
    return NextResponse.redirect(target)
}

function readBackendUrl(): string {
    const backendUrl = process.env.BACKEND_URL?.trim()
    if (backendUrl) {
        return backendUrl
    }

    if (process.env.NODE_ENV === "production") {
        throw new Error("BACKEND_URL is not configured for dashboard Codex OAuth proxy")
    }

    return "http://localhost:3100"
}

function readRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {}
}

function readBearerToken(header: string | null): string | null {
    const prefix = "Bearer "
    if (!header?.startsWith(prefix)) {
        return null
    }

    const token = header.slice(prefix.length).trim()
    return token || null
}

function readFirstHeaderValue(value: string | null): string | null {
    const first = value?.split(",")[0]?.trim()
    return first || null
}

function parseOrigin(value: string | null): string | null {
    if (!value) {
        return null
    }

    try {
        const parsed = new URL(value)
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return null
        }

        return parsed.origin
    } catch {
        return null
    }
}

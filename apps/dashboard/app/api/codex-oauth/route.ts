import { NextResponse } from "next/server"
import { ConvexHttpClient } from "convex/browser"
import { api } from "@valiq-trading/convex"

export const runtime = "nodejs"

type CodexOAuthAction = "status" | "start" | "submit" | "cancel"

export async function GET(request: Request): Promise<Response> {
    return handleCodexOAuthRequest(request)
}

export async function POST(request: Request): Promise<Response> {
    return handleCodexOAuthRequest(request)
}

async function handleCodexOAuthRequest(request: Request): Promise<Response> {
    try {
        await requireDashboardUser(request)

        const url = new URL(request.url)
        const action = readAction(url.searchParams.get("action"))
        const backendMethod = action === "status" ? "GET" : "POST"

        if (request.method !== backendMethod) {
            return NextResponse.json({ error: "Method not allowed" }, { status: 405 })
        }

        const payload = request.method === "POST" ? await readJsonRecord(request) : null
        return await proxyCodexOAuthRequest(action, payload)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return NextResponse.json({ error: message }, { status: 400 })
    }
}

async function requireDashboardUser(request: Request): Promise<void> {
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

async function proxyCodexOAuthRequest(
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

function readAction(value: string | null): CodexOAuthAction {
    if (value === "status" || value === "start" || value === "submit" || value === "cancel") {
        return value
    }

    throw new Error("Invalid Codex OAuth action")
}

async function readJsonRecord(request: Request): Promise<Record<string, unknown>> {
    try {
        const value = await request.json() as unknown
        return value && typeof value === "object" && !Array.isArray(value)
            ? value as Record<string, unknown>
            : {}
    } catch {
        return {}
    }
}

function readBearerToken(header: string | null): string | null {
    const prefix = "Bearer "
    if (!header?.startsWith(prefix)) {
        return null
    }

    const token = header.slice(prefix.length).trim()
    return token || null
}

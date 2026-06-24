import { ConvexHttpClient } from "convex/browser"
import { api } from "@valiq-trading/convex"

export type CodexOAuthAction = "status" | "start"

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
    options: { force?: boolean } = {}
): Promise<Response> {
    const serviceToken = process.env.BACKEND_SERVICE_TOKEN?.trim()
    if (!serviceToken) {
        throw new Error("BACKEND_SERVICE_TOKEN is not configured for dashboard Codex OAuth proxy")
    }

    const target = new URL(`/codex/oauth/${action}`, readBackendUrl())
    if (action === "start" && options.force) {
        target.searchParams.set("force", "1")
    }
    const response = await fetch(target, {
        method: action === "status" ? "GET" : "POST",
        headers: {
            "authorization": `Bearer ${serviceToken}`,
            "accept": "application/json",
        },
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

export function readAction(value: string | null): CodexOAuthAction {
    if (value === "status" || value === "start") {
        return value
    }

    throw new Error("Invalid Codex OAuth action")
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

function readBearerToken(header: string | null): string | null {
    const prefix = "Bearer "
    if (!header?.startsWith(prefix)) {
        return null
    }

    const token = header.slice(prefix.length).trim()
    return token || null
}

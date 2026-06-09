import { NextResponse } from "next/server"
import {
    buildDashboardCodexCallbackUrl,
    proxyCodexOAuthRequest,
    readAction,
    readJsonRecord,
    requireDashboardUser,
} from "@/lib/codex-oauth-server"

export const runtime = "nodejs"

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
        const backendPayload = action === "start"
            ? {
                ...(payload ?? {}),
                redirectUri: buildDashboardCodexCallbackUrl(request),
            }
            : payload

        return await proxyCodexOAuthRequest(action, backendPayload)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return NextResponse.json({ error: message }, { status: 400 })
    }
}

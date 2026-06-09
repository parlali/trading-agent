import { NextResponse } from "next/server"
import {
    proxyCodexOAuthRequest,
    readAction,
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

        return await proxyCodexOAuthRequest(action)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return NextResponse.json({ error: message }, { status: 400 })
    }
}

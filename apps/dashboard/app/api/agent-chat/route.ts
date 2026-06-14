import { requireDashboardUser } from "@/lib/codex-oauth-server"

export const maxDuration = 120
export const runtime = "nodejs"

const MAX_CHAT_MESSAGE_LENGTH = 8_000
const MAX_CHAT_ID_LENGTH = 160

type ChatRequestBody = {
    strategyId?: string
    message?: string
    chatSessionId?: string
    chatMessageId?: string
}

export async function GET(request: Request) {
    try {
        await requireDashboardUser(request)

        return await proxyBackendRequest("/agent-chat", {
            method: "GET",
        })
    } catch (error) {
        return Response.json({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        }, { status: errorStatus(error) })
    }
}

export async function POST(request: Request) {
    try {
        await requireDashboardUser(request)

        const body = readChatRequestBody(await request.json())
        if (!body.strategyId) {
            return Response.json({ error: "strategyId is required for agent chat" }, { status: 400 })
        }
        if (!body.message) {
            return Response.json({ error: "message is required for agent chat" }, { status: 400 })
        }

        return await proxyBackendRequest("/agent-chat", {
            method: "POST",
            body: JSON.stringify({
                strategyId: body.strategyId,
                message: body.message,
                chatSessionId: body.chatSessionId,
                chatMessageId: body.chatMessageId,
            }),
        })
    } catch (error) {
        return Response.json({
            error: error instanceof Error ? error.message : String(error),
        }, { status: errorStatus(error) })
    }
}

function readChatRequestBody(value: unknown): ChatRequestBody {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Request body must be an object")
    }

    const body = value as Record<string, unknown>
    return {
        strategyId: readBoundedString(body.strategyId, "strategyId", MAX_CHAT_ID_LENGTH),
        message: readBoundedString(body.message, "message", MAX_CHAT_MESSAGE_LENGTH),
        chatSessionId: readBoundedString(body.chatSessionId, "chatSessionId", MAX_CHAT_ID_LENGTH),
        chatMessageId: readBoundedString(body.chatMessageId, "chatMessageId", MAX_CHAT_ID_LENGTH),
    }
}

function readBoundedString(value: unknown, field: string, maxLength: number): string | undefined {
    if (value === undefined || value === null) {
        return undefined
    }
    if (typeof value !== "string") {
        throw new Error(`${field} must be a string`)
    }

    const trimmed = value.trim()
    if (!trimmed) {
        return undefined
    }
    if (trimmed.length > maxLength) {
        throw new Error(`${field} must be at most ${maxLength} characters`)
    }

    return trimmed
}

async function proxyBackendRequest(path: string, init: RequestInit): Promise<Response> {
    const backendUrl = process.env.BACKEND_URL?.trim()
    if (!backendUrl) {
        throw new Error("BACKEND_URL is not configured for dashboard agent chat proxy")
    }

    const serviceToken = process.env.BACKEND_SERVICE_TOKEN?.trim()
    if (!serviceToken) {
        throw new Error("BACKEND_SERVICE_TOKEN is not configured for dashboard agent chat proxy")
    }

    const response = await fetch(new URL(path, backendUrl), {
        ...init,
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceToken}`,
            ...init.headers,
        },
    })

    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: {
            "content-type": response.headers.get("content-type") ?? "application/json",
            "cache-control": "no-store",
        },
    })
}

function errorStatus(error: unknown): number {
    const message = error instanceof Error ? error.message : String(error)
    return message === "Dashboard authentication required" ? 401 : 400
}

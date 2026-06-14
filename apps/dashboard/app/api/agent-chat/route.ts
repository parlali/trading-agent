import { requireDashboardUser } from "@/lib/codex-oauth-server"

export const maxDuration = 120
export const runtime = "nodejs"

const MAX_CHAT_MESSAGE_LENGTH = 8_000
const MAX_CHAT_ID_LENGTH = 160

type ChatRequestBody = {
    message?: string
    chatSessionId?: string
    chatMessageId?: string
    mode?: "general" | "portfolio" | "operations" | "mcp"
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
        if (!body.message) {
            return Response.json({ error: "message is required for agent chat" }, { status: 400 })
        }

        return await proxyBackendRequest("/agent-chat", {
            method: "POST",
            body: JSON.stringify({
                message: body.message,
                chatSessionId: body.chatSessionId,
                chatMessageId: body.chatMessageId,
                mode: body.mode,
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
    rejectUnknownFields(body, ["message", "chatSessionId", "chatMessageId", "mode"])

    return {
        message: readBoundedString(body.message, "message", MAX_CHAT_MESSAGE_LENGTH),
        chatSessionId: readBoundedString(body.chatSessionId, "chatSessionId", MAX_CHAT_ID_LENGTH),
        chatMessageId: readBoundedString(body.chatMessageId, "chatMessageId", MAX_CHAT_ID_LENGTH),
        mode: readChatMode(body.mode),
    }
}

function rejectUnknownFields(body: Record<string, unknown>, allowed: string[]): void {
    const allowedFields = new Set(allowed)
    const unknown = Object.keys(body).filter((field) => !allowedFields.has(field))
    if (unknown.length > 0) {
        throw new Error(`Unsupported agent chat field(s): ${unknown.join(", ")}`)
    }
}

function readChatMode(value: unknown): ChatRequestBody["mode"] {
    if (value === undefined || value === null || value === "") {
        return undefined
    }
    if (value === "general" || value === "portfolio" || value === "operations" || value === "mcp") {
        return value
    }

    throw new Error("mode must be one of general, portfolio, operations, or mcp")
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

import { requireDashboardUser } from "@/lib/codex-oauth-server"

export const maxDuration = 120
export const runtime = "nodejs"

const MAX_CHAT_MESSAGE_LENGTH = 8_000
const MAX_CHAT_ID_LENGTH = 160
const MAX_CHAT_MODEL_ID_LENGTH = 200
const MAX_CHAT_STRATEGY_ID_LENGTH = 160
const INTERNAL_ERROR_MESSAGE = "An internal error occurred"

type ChatRequestBody = {
    message?: string
    modelProvider?: "codex" | "openrouter"
    modelId?: string
    chatSessionId?: string
    chatMessageId?: string
    strategyId?: string
    mode?: "general" | "portfolio" | "operations" | "mcp"
}

export async function GET(request: Request) {
    try {
        await requireDashboardUser(request)
        const searchParams = new URL(request.url).searchParams
        const backendParams = new URLSearchParams()
        const chatSessionId = readBoundedString(searchParams.get("chatSessionId"), "chatSessionId", MAX_CHAT_ID_LENGTH)
        const strategyId = readBoundedString(searchParams.get("strategyId"), "strategyId", MAX_CHAT_STRATEGY_ID_LENGTH)
        if (chatSessionId) {
            backendParams.set("chatSessionId", chatSessionId)
        }
        if (strategyId) {
            backendParams.set("strategyId", strategyId)
        }
        const query = backendParams.toString()
        const path = query ? `/agent-chat?${query}` : "/agent-chat"

        return await proxyBackendRequest(path, {
            method: "GET",
        }, request.signal)
    } catch (error) {
        return agentChatErrorResponse(error, true)
    }
}

export async function POST(request: Request) {
    try {
        await requireDashboardUser(request)

        const body = readChatRequestBody(await request.json())
        if (!body.message) {
            return Response.json({ error: "message is required for agent chat" }, { status: 400 })
        }
        if (!body.modelProvider) {
            return Response.json({ error: "modelProvider is required for agent chat" }, { status: 400 })
        }
        if (!body.modelId) {
            return Response.json({ error: "modelId is required for agent chat" }, { status: 400 })
        }

        return await proxyBackendRequest("/agent-chat", {
            method: "POST",
            body: JSON.stringify({
                message: body.message,
                modelProvider: body.modelProvider,
                modelId: body.modelId,
                chatSessionId: body.chatSessionId,
                chatMessageId: body.chatMessageId,
                strategyId: body.strategyId,
                mode: body.mode,
            }),
        }, request.signal)
    } catch (error) {
        return agentChatErrorResponse(error)
    }
}

function readChatRequestBody(value: unknown): ChatRequestBody {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Request body must be an object")
    }

    const body = value as Record<string, unknown>
    rejectUnknownFields(body, ["message", "modelProvider", "modelId", "chatSessionId", "chatMessageId", "strategyId", "mode"])

    return {
        message: readBoundedString(body.message, "message", MAX_CHAT_MESSAGE_LENGTH),
        modelProvider: readModelProvider(body.modelProvider),
        modelId: readBoundedString(body.modelId, "modelId", MAX_CHAT_MODEL_ID_LENGTH),
        chatSessionId: readBoundedString(body.chatSessionId, "chatSessionId", MAX_CHAT_ID_LENGTH),
        chatMessageId: readBoundedString(body.chatMessageId, "chatMessageId", MAX_CHAT_ID_LENGTH),
        strategyId: readBoundedString(body.strategyId, "strategyId", MAX_CHAT_STRATEGY_ID_LENGTH),
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

function readModelProvider(value: unknown): ChatRequestBody["modelProvider"] {
    if (value === undefined || value === null || value === "") {
        return undefined
    }
    if (value === "codex" || value === "openrouter") {
        return value
    }

    throw new Error("modelProvider must be codex or openrouter")
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

async function proxyBackendRequest(path: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
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
        signal,
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceToken}`,
            ...init.headers,
        },
    })

    if (response.status >= 500) {
        await response.body?.cancel()
        return Response.json({
            error: INTERNAL_ERROR_MESSAGE,
        }, {
            status: response.status,
            statusText: response.statusText,
            headers: {
                "cache-control": "no-store",
            },
        })
    }

    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: {
            "content-type": response.headers.get("content-type") ?? "application/json",
            "cache-control": "no-store",
        },
    })
}

function agentChatErrorResponse(error: unknown, includeOk = false): Response {
    const status = errorStatus(error)
    return Response.json({
        ...(includeOk ? { ok: false } : {}),
        error: status >= 500 ? INTERNAL_ERROR_MESSAGE : errorMessage(error),
    }, { status })
}

function errorStatus(error: unknown): number {
    const message = errorMessage(error)
    if (message === "Dashboard authentication required") {
        return 401
    }
    if (isClientRequestError(error, message)) {
        return 400
    }
    if (isProxyConfigurationError(message)) {
        return 503
    }
    if (isBackendGatewayError(error, message)) {
        return 502
    }

    return 500
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function isClientRequestError(error: unknown, message: string): boolean {
    return error instanceof SyntaxError ||
        message === "Request body must be an object" ||
        message.startsWith("Unsupported agent chat field(s):") ||
        message === "modelProvider must be codex or openrouter" ||
        message === "mode must be one of general, portfolio, operations, or mcp" ||
        message.startsWith("message must ") ||
        message.startsWith("modelId must ") ||
        message.startsWith("chatSessionId must ") ||
        message.startsWith("chatMessageId must ")
}

function isProxyConfigurationError(message: string): boolean {
    return message.startsWith("BACKEND_URL is not configured") ||
        message.startsWith("BACKEND_SERVICE_TOKEN is not configured") ||
        message === "Invalid URL"
}

function isBackendGatewayError(error: unknown, message: string): boolean {
    return error instanceof TypeError ||
        message.includes("fetch failed") ||
        message.includes("ECONNREFUSED") ||
        message.includes("ENOTFOUND") ||
        message.includes("ETIMEDOUT")
}

import type { UIMessage } from "ai"

export const maxDuration = 120

type ChatRequestBody = {
    messages?: UIMessage[]
    strategyId?: string
}

export async function GET() {
    try {
        return await proxyBackendRequest("/agent-chat", {
            method: "GET",
        })
    } catch (error) {
        return Response.json({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        }, { status: 500 })
    }
}

export async function POST(request: Request) {
    try {
        const model = resolveAgentChatModel()
        const body = await request.json() as ChatRequestBody
        if (!Array.isArray(body.messages)) {
            return Response.json({ error: "messages must be an array" }, { status: 400 })
        }
        if (!body.strategyId) {
            return Response.json({ error: "strategyId is required for agent chat" }, { status: 400 })
        }

        return await proxyBackendRequest("/agent-chat", {
            method: "POST",
            body: JSON.stringify({
                strategyId: body.strategyId,
                messages: body.messages,
                model,
            }),
        })
    } catch (error) {
        return Response.json({
            error: error instanceof Error ? error.message : String(error),
        }, { status: 500 })
    }
}

function resolveAgentChatModel(): string {
    const model = process.env.AGENT_CHAT_MODEL?.trim()
    if (!model) {
        throw new Error("AGENT_CHAT_MODEL is not configured")
    }

    return model
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
        headers: response.headers,
    })
}

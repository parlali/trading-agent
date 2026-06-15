import {
    createUIMessageStreamResponse,
} from "ai"
import { z } from "zod/v4"
import type { Scheduler } from "@valiq-trading/core"
import {
    backendServiceToken,
    logger,
} from "./state"
import {
    createAgentChatUiMessageStream,
    getAgentChatInventory,
} from "./agent-chat-runtime"

const MAX_CHAT_MESSAGE_LENGTH = 8_000
const MAX_CHAT_ID_LENGTH = 160
const MAX_CHAT_MODEL_ID_LENGTH = 200

export const agentChatRequestSchema = z.strictObject({
    message: z.string().trim().min(1).max(MAX_CHAT_MESSAGE_LENGTH),
    modelProvider: z.enum(["codex", "openrouter"]),
    modelId: z.string().trim().min(1).max(MAX_CHAT_MODEL_ID_LENGTH),
    chatSessionId: z.string().trim().min(1).max(MAX_CHAT_ID_LENGTH).optional(),
    chatMessageId: z.string().trim().min(1).max(MAX_CHAT_ID_LENGTH).optional(),
    mode: z.enum(["general", "portfolio", "operations", "mcp"]).optional(),
})

const agentChatInventoryRequestSchema = z.strictObject({
    chatSessionId: z.string().trim().min(1).max(MAX_CHAT_ID_LENGTH).optional(),
})

export type AgentChatRequest = z.infer<typeof agentChatRequestSchema>

export interface AgentChatHandlerDependencies {
    serviceToken?: string
    createStream?: typeof createAgentChatUiMessageStream
    getInventory?: typeof getAgentChatInventory
    logError?: (message: string, fields?: Record<string, unknown>) => void
}

export async function handleAgentChatRequest(
    request: Request,
    _scheduler?: Scheduler,
    dependencies: AgentChatHandlerDependencies = {}
): Promise<Response | undefined> {
    const { pathname } = new URL(request.url)
    if (pathname !== "/agent-chat") {
        return undefined
    }

    const serviceToken = dependencies.serviceToken ?? backendServiceToken
    if (!isAuthorized(request, serviceToken)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 })
    }

    if (request.method === "GET") {
        try {
            const inventoryRequest = readAgentChatInventoryRequest(request)
            const inventory = await (dependencies.getInventory ?? getAgentChatInventory)({
                abortSignal: request.signal,
                chatSessionId: inventoryRequest.chatSessionId,
            })

            return Response.json({
                ok: true,
                ...inventory,
            }, {
                headers: {
                    "cache-control": "no-store",
                },
            })
        } catch (error) {
            return jsonError(error, dependencies, requestErrorStatus(error))
        }
    }

    if (request.method !== "POST") {
        return Response.json({ error: "Method not allowed" }, { status: 405 })
    }

    try {
        const body = await readAgentChatRequest(request)
        const stream = await (dependencies.createStream ?? createAgentChatUiMessageStream)({
            request: body,
            abortSignal: request.signal,
        })

        return createUIMessageStreamResponse({
            stream,
            headers: {
                "cache-control": "no-store",
            },
        })
    } catch (error) {
        return jsonError(error, dependencies, requestErrorStatus(error))
    }
}

function readAgentChatInventoryRequest(request: Request): z.infer<typeof agentChatInventoryRequestSchema> {
    const { searchParams } = new URL(request.url)
    return agentChatInventoryRequestSchema.parse({
        chatSessionId: searchParams.get("chatSessionId") ?? undefined,
    })
}

async function readAgentChatRequest(request: Request): Promise<AgentChatRequest> {
    let json: unknown
    try {
        json = await request.json()
    } catch {
        throw new Error("Request body must be valid JSON")
    }

    return agentChatRequestSchema.parse(json)
}

function jsonError(
    error: unknown,
    dependencies: AgentChatHandlerDependencies,
    status: number
): Response {
    const message = error instanceof Error ? error.message : String(error)
    const logError = dependencies.logError ?? ((entry, fields) => logger.error(entry, fields))
    logError("Agent chat request failed", {
        error: message,
    })

    return Response.json({
        error: message,
    }, { status })
}

function requestErrorStatus(error: unknown): number {
    const message = error instanceof Error ? error.message : String(error)
    if (message === "Request body must be valid JSON" || error instanceof z.ZodError) {
        return 400
    }
    if (message.includes("model not found")) {
        return 404
    }
    if (
        message.includes("OPENROUTER_API_KEY is not configured") ||
        message.includes("Codex ChatGPT login is not configured")
    ) {
        return 503
    }

    return 500
}

function isAuthorized(request: Request, serviceToken: string): boolean {
    const header = request.headers.get("authorization")
    return header === `Bearer ${serviceToken}`
}

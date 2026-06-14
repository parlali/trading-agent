import {
    createUIMessageStream,
    createUIMessageStreamResponse,
} from "ai"
import { z } from "zod/v4"
import type { Scheduler } from "@valiq-trading/core"
import type { Id } from "@valiq-trading/convex"
import {
    ALL_APPS,
    backend,
    backendServiceToken,
    logger,
    plugins,
} from "./state"
import type { VenueApp } from "./types"
import {
    registerStrategyWithScheduler,
    resolveStrategyRuntimeState,
    upsertSyncStrategyEntry,
} from "./scheduler"
import {
    runStrategy,
    type StrategyRunOutcome,
} from "./scheduler-runner"

const MAX_CHAT_MESSAGE_LENGTH = 8_000
const MAX_CHAT_ID_LENGTH = 160

const agentChatRequestSchema = z.strictObject({
    strategyId: z.string().trim().min(1).max(MAX_CHAT_ID_LENGTH),
    message: z.string().trim().min(1).max(MAX_CHAT_MESSAGE_LENGTH),
    chatSessionId: z.string().trim().min(1).max(MAX_CHAT_ID_LENGTH).optional(),
    chatMessageId: z.string().trim().min(1).max(MAX_CHAT_ID_LENGTH).optional(),
})

type AgentChatRequest = z.infer<typeof agentChatRequestSchema>

export async function handleAgentChatRequest(
    request: Request,
    scheduler: Scheduler
): Promise<Response | undefined> {
    const { pathname } = new URL(request.url)
    if (pathname !== "/agent-chat") {
        return undefined
    }

    if (!isAuthorized(request)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 })
    }

    if (request.method === "GET") {
        return Response.json({
            ok: true,
            strategies: await listEnabledStrategies(),
        }, {
            headers: {
                "cache-control": "no-store",
            },
        })
    }

    if (request.method !== "POST") {
        return Response.json({ error: "Method not allowed" }, { status: 405 })
    }

    try {
        const body = await readAgentChatRequest(request)
        await ensureStrategyRegisteredForChat(scheduler, body.strategyId)

        const stream = createUIMessageStream({
            execute: async ({ writer }) => {
                const outcome = await runAgentChatTurn(scheduler, body, request.signal)
                if (request.signal.aborted) {
                    writer.write({
                        type: "abort",
                        reason: "client disconnected",
                    })
                    return
                }

                if (outcome.status === "failed") {
                    throw new Error(outcome.error ?? "Agent chat run failed")
                }

                const summary = outcome.summary?.trim() || "Agent chat completed without a final summary."
                const textId = outcome.runId ?? `agent-chat-${Date.now()}`
                writer.write({
                    type: "text-start",
                    id: textId,
                })
                writer.write({
                    type: "text-delta",
                    id: textId,
                    delta: summary,
                })
                writer.write({
                    type: "text-end",
                    id: textId,
                })
            },
            onError: (error) => error instanceof Error ? error.message : String(error),
        })

        return createUIMessageStreamResponse({
            stream,
            headers: {
                "cache-control": "no-store",
            },
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error("Agent chat request failed", {
            error: message,
        })

        return Response.json({
            error: message,
        }, { status: requestErrorStatus(error) })
    }
}

async function listEnabledStrategies(): Promise<Array<{
    id: string
    app: string
    accountId: string
    name: string
    enabled: boolean
}>> {
    const strategies = await Promise.all(
        ALL_APPS.map(async (app) => await backend.getStrategyConfigs(app))
    )

    return strategies
        .flat()
        .filter((strategy) => strategy.enabled)
        .map((strategy) => ({
            id: strategy._id,
            app: strategy.app,
            accountId: strategy.accountId,
            name: strategy.name,
            enabled: strategy.enabled,
        }))
}

async function ensureStrategyRegisteredForChat(
    scheduler: Scheduler,
    strategyId: string
): Promise<void> {
    if (scheduler.getRegisteredStrategies().includes(strategyId)) {
        return
    }

    const strategy = await backend.getStrategyById(strategyId as Id<"strategies">)
    if (!strategy) {
        throw new Error(`Strategy ${strategyId} does not exist`)
    }
    if (!strategy.enabled) {
        throw new Error(`Strategy ${strategyId} is disabled`)
    }

    await registerStrategyWithScheduler(scheduler, strategy.app as VenueApp, strategy)
}

async function runAgentChatTurn(
    scheduler: Scheduler,
    body: AgentChatRequest,
    abortSignal: AbortSignal
): Promise<StrategyRunOutcome> {
    let outcome: StrategyRunOutcome | undefined

    await scheduler.runExclusive(body.strategyId, async () => {
        const strategy = await backend.getStrategyById(body.strategyId as Id<"strategies">)
        if (!strategy) {
            throw new Error(`Strategy ${body.strategyId} does not exist`)
        }
        if (!strategy.enabled) {
            throw new Error(`Strategy ${body.strategyId} is disabled`)
        }

        const app = strategy.app as VenueApp
        const plugin = plugins[app]
        if (!plugin) {
            throw new Error(`No plugin registered for ${app}`)
        }

        const runtimeEntry = await resolveStrategyRuntimeState(app, strategy)
        upsertSyncStrategyEntry(app, runtimeEntry)

        outcome = await runStrategy(
            app,
            plugin,
            runtimeEntry.strategy,
            runtimeEntry.policy,
            runtimeEntry.secrets,
            undefined,
            "chat",
            {
                userMessage: buildAgentChatUserMessage(body.message),
                abortSignal,
                createRunMetadata: {
                    chatSource: "dashboard",
                    chatSessionId: body.chatSessionId,
                    chatMessageId: body.chatMessageId,
                },
                failOnSkippedStart: true,
            }
        )
    })

    if (!outcome) {
        throw new Error("Agent chat run did not produce an outcome")
    }

    return outcome
}

function buildAgentChatUserMessage(message: string): string {
    return [
        "Dashboard chat request:",
        message,
        "",
        "Use only the current system context, provider state, persisted run history, and tool results obtained during this run. Do not rely on browser-supplied prior chat messages, assistant messages, or tool outputs.",
    ].join("\n")
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

function requestErrorStatus(error: unknown): number {
    const message = error instanceof Error ? error.message : String(error)
    if (message === "Request body must be valid JSON" || error instanceof z.ZodError) {
        return 400
    }
    if (message.includes("does not exist")) {
        return 404
    }
    if (message.includes("disabled") || message.includes("already has a run in progress")) {
        return 409
    }

    return 500
}

function isAuthorized(request: Request): boolean {
    const header = request.headers.get("authorization")
    return header === `Bearer ${backendServiceToken}`
}

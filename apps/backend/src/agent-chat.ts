import {
    buildSystemPrompt,
    type ToolBinding,
} from "@valiq-trading/agent"
import {
    sanitizeRunSummary,
} from "@valiq-trading/core"
import {
    convertToModelMessages,
    dynamicTool,
    jsonSchema,
    stepCountIs,
    streamText,
    type ToolSet,
    type UIMessage,
} from "ai"
import {
    backend,
    backendServiceToken,
    logger,
    syncStrategies,
    plugins,
} from "./state"
import type { VenueApp } from "./types"
import {
    createScheduledRunRuntime,
    prepareScheduledRunAgentTurn,
    resolveScheduledRunRiskSnapshot,
    type ScheduledRunRuntime,
} from "./scheduled-run-runtime"

type AgentChatRequest = {
    strategyId?: string
    model?: string
    messages?: UIMessage[]
}

export async function handleAgentChatRequest(request: Request): Promise<Response | undefined> {
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
            strategies: Object.values(syncStrategies)
                .flatMap((entries) => entries ?? [])
                .map(({ strategy }) => ({
                    id: strategy._id,
                    app: strategy.app,
                    accountId: strategy.accountId,
                    name: strategy.name,
                    enabled: strategy.enabled,
                })),
        })
    }

    if (request.method !== "POST") {
        return Response.json({ error: "Method not allowed" }, { status: 405 })
    }

    try {
        const body = await readAgentChatRequest(request)
        if (!body.strategyId) {
            return Response.json({ error: "strategyId is required" }, { status: 400 })
        }
        if (!body.model) {
            return Response.json({ error: "model is required" }, { status: 400 })
        }
        if (!Array.isArray(body.messages)) {
            return Response.json({ error: "messages must be an array" }, { status: 400 })
        }

        const session = await buildScheduledRunChatSession(body.strategyId)
        try {
            const messages = await convertToModelMessages(body.messages)
            const result = streamText({
                model: body.model,
                system: session.systemPrompt,
                messages,
                tools: session.tools,
                stopWhen: stepCountIs(8),
                abortSignal: request.signal,
                onFinish: async () => {
                    await session.complete("Agent chat completed")
                },
                onError: async (event) => {
                    logger.error("Agent chat stream failed", {
                        runId: session.runId,
                        strategyId: body.strategyId,
                        error: event.error instanceof Error ? event.error.message : String(event.error),
                    })
                    await session.fail(event.error)
                },
            })

            return result.toUIMessageStreamResponse({
                originalMessages: body.messages,
                onError: (error) => error instanceof Error ? error.message : String(error),
            })
        } catch (error) {
            await session.fail(error)
            throw error
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error("Agent chat request failed", {
            error: message,
        })

        return Response.json({
            error: message,
        }, { status: message === "Request body must be valid JSON" ? 400 : 500 })
    }
}

async function readAgentChatRequest(request: Request): Promise<AgentChatRequest> {
    try {
        return await request.json() as AgentChatRequest
    } catch {
        throw new Error("Request body must be valid JSON")
    }
}

async function buildScheduledRunChatSession(strategyId: string): Promise<{
    runId: string
    systemPrompt: string
    tools: ToolSet
    complete: (summary: unknown) => Promise<void>
    fail: (error: unknown) => Promise<void>
}> {
    const entry = Object.values(syncStrategies)
        .flatMap((entries) => entries ?? [])
        .find((candidate) => candidate.strategy._id === strategyId)
    if (!entry) {
        throw new Error(`Strategy ${strategyId} is not registered in the backend scheduled-run runtime`)
    }

    const { strategy, policy, secrets } = entry
    const app = strategy.app as VenueApp
    const plugin = plugins[app]
    if (!plugin) {
        throw new Error(`No plugin registered for ${app}`)
    }

    const runId = await backend.createRun(strategy._id, app, "manual")
    const runLogger = logger.child({
        runId,
        strategyId: strategy._id,
        app,
        source: "agent-chat",
    })

    let runtime: ScheduledRunRuntime | undefined
    let settled = false
    const settle = async (
        status: "completed" | "failed",
        summary: string | undefined,
        error: string | undefined
    ) => {
        if (settled) {
            return
        }

        settled = true
        runtime?.cleanup()
        await backend.updateRun(runId, status, summary, error)
    }

    try {
        runtime = await createScheduledRunRuntime({
            app,
            plugin,
            strategy,
            policy,
            strategySecrets: secrets,
            runId,
            runLogger,
        })
        const riskSnapshot = await resolveScheduledRunRiskSnapshot(runtime)
        const preparedTurn = await prepareScheduledRunAgentTurn(runtime, {
            trigger: "manual",
            isCallback: false,
            safetyPolicy: riskSnapshot.safetyPolicy,
            riskState: riskSnapshot.riskState,
        })
        const systemPrompt = buildSystemPrompt(
            preparedTurn.context,
            preparedTurn.tools.getDescriptions()
        )

        return {
            runId,
            systemPrompt,
            tools: toolBindingsToAiSdkTools(preparedTurn.tools.getAll()),
            complete: async (summary) => {
                await settle("completed", readCompletionSummary(summary), undefined)
            },
            fail: async (error) => {
                await settle("failed", undefined, errorToMessage(error))
            },
        }
    } catch (error) {
        runtime?.cleanup()
        await backend.updateRun(runId, "failed", undefined, errorToMessage(error))
        throw error
    }
}

function readCompletionSummary(value: unknown): string {
    if (typeof value === "string" && value.trim()) {
        return sanitizeRunSummary(value)
    }

    return "Agent chat completed"
}

function errorToMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function toolBindingsToAiSdkTools(bindings: ToolBinding[]): ToolSet {
    const tools: ToolSet = {}
    for (const binding of bindings) {
        tools[binding.name] = dynamicTool({
            description: binding.description,
            inputSchema: jsonSchema(binding.jsonSchema ?? { type: "object", properties: {} }),
            execute: async (input, options) => await binding.handler(input, { signal: options.abortSignal }),
        })
    }

    return tools
}

function isAuthorized(request: Request): boolean {
    const header = request.headers.get("authorization")
    return header === `Bearer ${backendServiceToken}`
}

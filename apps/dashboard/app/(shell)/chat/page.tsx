"use client"

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useChat } from "@ai-sdk/react"
import { useAuthToken } from "@convex-dev/auth/react"
import {
    DefaultChatTransport,
    getToolName,
    isToolOrDynamicToolUIPart,
    type UIMessage,
} from "ai"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
    Bot,
    Braces,
    CircleAlert,
    Loader2,
    RefreshCw,
    Send,
    Square,
    User,
    Wrench,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select"
import { MarkdownContent } from "@/components/markdown-content"
import { cn } from "@/lib/utils"

type AgentChatModelProvider = "codex" | "openrouter"

type ToolInventoryResponse = {
    ok: boolean
    error?: string
    modelProviders?: Array<{
        provider: AgentChatModelProvider
        configured: boolean
        defaultModelId?: string
        modelIds?: string[]
        reason?: string
    }>
    tools?: Array<{
        name: string
        category?: string
        contractBoundary?: string
        contractOwner?: string
        description: string
        outputDescription?: string
        errorSemantics?: string
    }>
    mcpProviders?: Array<{
        id: string
        toolCount: number
        status: "available" | "unavailable"
        error?: string
    }>
    manualTrading?: {
        enabled: false
        reason: string
    }
    messages?: Array<{
        messageId: string
        role: "user" | "assistant"
        content: string
        status: "received" | "completed" | "cancelled" | "failed"
        reasoning?: string
        error?: string
        toolEvents?: Array<{
            toolCallId: string
            toolName: string
            state: "input" | "result" | "error"
            input?: unknown
            output?: unknown
            error?: string
        }>
    }>
}

type MessagePart = UIMessage["parts"][number]
type ServerChatMessage = NonNullable<ToolInventoryResponse["messages"]>[number]
type ServerToolEvent = NonNullable<ServerChatMessage["toolEvents"]>[number]
const CHAT_SESSION_STORAGE_KEY = "dashboard-agent-chat-session-id"

export default function AgentChatPage() {
    const authToken = useAuthToken()
    const [chatSessionId] = useState(resolveDashboardChatSessionId)
    const [input, setInput] = useState("")
    const [modelProvider, setModelProvider] = useState<AgentChatModelProvider>("codex")
    const [modelId, setModelId] = useState("")
    const [inventory, setInventory] = useState<ToolInventoryResponse | null>(null)
    const [inventoryLoading, setInventoryLoading] = useState(false)
    const [inventoryError, setInventoryError] = useState<string | null>(null)
    const parentRef = useRef<HTMLDivElement | null>(null)
    const isRunningRef = useRef(false)
    const chatTransport = useMemo(() => new DefaultChatTransport({
        api: "/api/agent-chat",
        prepareSendMessagesRequest({ messages, id, messageId, body, headers }) {
            const requestHeaders = headersToRecord(headers)
            const authorization = requestHeaders.authorization ?? requestHeaders.Authorization ?? (authToken ? `Bearer ${authToken}` : "")
            if (!authorization) {
                throw new Error("Dashboard authentication is not ready")
            }

            return {
                headers: {
                    ...requestHeaders,
                    authorization,
                },
                body: {
                    message: readLatestUserText(messages),
                    modelProvider: readTransportModelProvider(body?.modelProvider),
                    modelId: readTransportModelId(body?.modelId),
                    chatSessionId: id || chatSessionId,
                    chatMessageId: messageId ?? messages[messages.length - 1]?.id,
                    mode: "general",
                },
            }
        },
    }), [authToken, chatSessionId])

    const {
        messages,
        setMessages,
        sendMessage,
        stop,
        status,
        error,
    } = useChat({
        id: chatSessionId,
        transport: chatTransport,
        experimental_throttle: 60,
    })

    const rowVirtualizer = useVirtualizer({
        count: messages.length,
        getScrollElement: () => parentRef.current,
        estimateSize: () => 240,
        overscan: 6,
    })

    const virtualItems = rowVirtualizer.getVirtualItems()
    const isRunning = status === "submitted" || status === "streaming"
    const runtimeTools = useMemo(
        () => inventory?.tools ?? [],
        [inventory]
    )
    const modelProviders = inventory?.modelProviders ?? []
    const selectedModelProvider = modelProviders.find((provider) => provider.provider === modelProvider)
    const selectedProviderConfigured = selectedModelProvider?.configured === true
    const selectedProviderReason = selectedModelProvider?.reason
    const codexModelIds = selectedModelProvider?.provider === "codex"
        ? selectedModelProvider.modelIds ?? []
        : []
    const mcpProviders = inventory?.mcpProviders ?? []
    const canSubmit = input.trim().length > 0 &&
        modelId.trim().length > 0 &&
        selectedProviderConfigured &&
        !isRunning &&
        Boolean(authToken)

    useEffect(() => {
        isRunningRef.current = isRunning
    }, [isRunning])

    const loadInventory = useCallback(async (options: {
        hydrateTranscript?: boolean
    } = {}) => {
        if (!authToken) {
            setInventory(null)
            setInventoryError("Dashboard authentication is not ready")
            return
        }

        setInventoryLoading(true)
        setInventoryError(null)

        try {
            const hydrateTranscript = options.hydrateTranscript === true
            const path = hydrateTranscript
                ? `/api/agent-chat?chatSessionId=${encodeURIComponent(chatSessionId)}`
                : "/api/agent-chat"
            const response = await fetch(path, {
                headers: {
                    "authorization": `Bearer ${authToken}`,
                },
                cache: "no-store",
            })
            const payload = await response.json() as ToolInventoryResponse
            if (!response.ok || !payload.ok) {
                throw new Error(payload.error || `Inventory request failed with HTTP ${response.status}`)
            }

            setInventory(payload)
            if (hydrateTranscript && payload.messages && !isRunningRef.current) {
                setMessages(toUiMessages(payload.messages))
            }
        } catch (loadError) {
            setInventory(null)
            setInventoryError(loadError instanceof Error ? loadError.message : String(loadError))
        } finally {
            setInventoryLoading(false)
        }
    }, [authToken, chatSessionId, setMessages])

    useEffect(() => {
        void loadInventory({ hydrateTranscript: true })
    }, [loadInventory])

    useEffect(() => {
        if (modelProviders.length === 0) {
            return
        }

        const current = modelProviders.find((provider) => provider.provider === modelProvider)
        const fallback = modelProviders.find((provider) => provider.provider === "codex" && provider.configured) ??
            modelProviders.find((provider) => provider.configured)
        const next = current?.configured ? current : fallback
        if (!next) {
            return
        }

        if (next.provider !== modelProvider) {
            setModelProvider(next.provider)
        }

        if (next.provider === "codex") {
            const modelIds = next.modelIds ?? []
            const nextModelId = modelIds.includes(modelId)
                ? modelId
                : next.defaultModelId ?? modelIds[0] ?? ""
            if (nextModelId !== modelId) {
                setModelId(nextModelId)
            }
        }
    }, [modelId, modelProvider, modelProviders])

    useEffect(() => {
        if (messages.length > 0) {
            rowVirtualizer.scrollToIndex(messages.length - 1, { align: "end" })
        }
    }, [messages.length, status, rowVirtualizer])

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault()
        const text = input.trim()
        const selectedModelId = modelId.trim()
        if (!text || !canSubmit || !authToken) {
            return
        }

        setInput("")
        void sendMessage({ text }, {
            headers: {
                authorization: `Bearer ${authToken}`,
            },
            body: {
                modelProvider,
                modelId: selectedModelId,
            },
        })
    }

    function handleModelProviderChange(value: AgentChatModelProvider) {
        const next = modelProviders.find((provider) => provider.provider === value)
        setModelProvider(value)
        if (value === "codex") {
            setModelId(next?.defaultModelId ?? next?.modelIds?.[0] ?? "")
            return
        }
        if (modelProvider === "codex") {
            setModelId("")
        }
    }

    return (
        <div className="grid h-[calc(100vh-6rem)] min-h-[620px] grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <section className="flex min-h-0 flex-col rounded-md border border-border-subtle bg-card">
                <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border-subtle px-4 py-3">
                    <div className="min-w-0">
                        <h1 className="text-sm font-semibold">Agent Chat</h1>
                        <p className="truncate text-xs text-muted-foreground">
                            Global owner chat across configured broker, portfolio, and MCP read tools
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        <Badge variant={isRunning ? "secondary" : "outline"} className="text-[10px] capitalize">
                            {status}
                        </Badge>
                        {isRunning ? (
                            <Button type="button" variant="outline" size="sm" onClick={stop}>
                                <Square className="h-3.5 w-3.5" />
                                Stop
                            </Button>
                        ) : null}
                    </div>
                </div>

                <div ref={parentRef} className="min-h-0 flex-1 overflow-auto px-3 py-3">
                    {messages.length === 0 ? (
                        <EmptyChat />
                    ) : (
                        <div
                            className="relative w-full"
                            style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
                        >
                            {virtualItems.map((virtualItem) => {
                                const message = messages[virtualItem.index]
                                if (!message) {
                                    return null
                                }

                                return (
                                    <div
                                        key={message.id}
                                        data-index={virtualItem.index}
                                        ref={rowVirtualizer.measureElement}
                                        className="absolute left-0 top-0 w-full pb-3"
                                        style={{ transform: `translateY(${virtualItem.start}px)` }}
                                    >
                                        <MessageBubble message={message} />
                                    </div>
                                )
                            })}
                        </div>
                    )}
                </div>

                <form onSubmit={handleSubmit} className="shrink-0 border-t border-border-subtle p-3">
                    <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-[180px_minmax(0,1fr)]">
                        <div className="space-y-1.5">
                            <Label className="text-[11px] text-muted-foreground">Provider</Label>
                            <Select
                                value={modelProvider}
                                onValueChange={(value) => handleModelProviderChange(value as AgentChatModelProvider)}
                                disabled={isRunning || modelProviders.length === 0}
                            >
                                <SelectTrigger className="h-9 w-full">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {modelProviders.map((provider) => (
                                        <SelectItem key={provider.provider} value={provider.provider} disabled={!provider.configured}>
                                            {provider.provider === "codex" ? "Codex" : "OpenRouter"}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="space-y-1.5">
                            <Label className="text-[11px] text-muted-foreground">
                                {modelProvider === "codex" ? "Codex Model" : "OpenRouter Model"}
                            </Label>
                            {modelProvider === "codex" ? (
                                <Select
                                    value={modelId}
                                    onValueChange={setModelId}
                                    disabled={isRunning || !selectedProviderConfigured || codexModelIds.length === 0}
                                >
                                    <SelectTrigger className="h-9 w-full font-mono">
                                        <SelectValue placeholder="Select a Codex model" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {codexModelIds.map((id) => (
                                            <SelectItem key={id} value={id}>
                                                {id}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            ) : (
                                <Input
                                    value={modelId}
                                    onChange={(event) => setModelId(event.target.value)}
                                    placeholder="anthropic/claude-sonnet-4.6"
                                    disabled={isRunning || !selectedProviderConfigured}
                                    className="font-mono"
                                />
                            )}
                        </div>
                    </div>
                    {selectedProviderReason && !selectedProviderConfigured ? (
                        <div className="mb-2 flex items-start gap-2 rounded-md border border-signal-danger/30 bg-signal-danger/10 px-3 py-2 text-xs text-signal-danger">
                            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            <span className="break-words">{selectedProviderReason}</span>
                        </div>
                    ) : null}
                    {error ? (
                        <div className="mb-2 flex items-start gap-2 rounded-md border border-signal-danger/30 bg-signal-danger/10 px-3 py-2 text-xs text-signal-danger">
                            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            <span className="break-words">{error.message}</span>
                        </div>
                    ) : null}
                    <div className="flex items-end gap-2">
                        <Textarea
                            value={input}
                            onChange={(event) => setInput(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                                    event.currentTarget.form?.requestSubmit()
                                }
                            }}
                            placeholder="Ask the agent anything or request work with the configured MCP tools"
                            className="max-h-40 min-h-20 resize-none text-sm"
                            disabled={isRunning || !authToken}
                        />
                        <Button type="submit" size="icon" disabled={!canSubmit} aria-label="Send message">
                            {isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                        </Button>
                    </div>
                </form>
            </section>

            <aside className="flex min-h-0 flex-col rounded-md border border-border-subtle bg-card">
                <div className="flex items-center justify-between gap-2 border-b border-border-subtle px-4 py-3">
                    <div>
                        <h2 className="text-sm font-semibold">Runtime</h2>
                        <p className="text-xs text-muted-foreground">{runtimeTools.length} exposed chat tools</p>
                    </div>
                    <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        onClick={() => void loadInventory()}
                        disabled={inventoryLoading || !authToken || isRunning}
                        aria-label="Refresh MCP inventory"
                    >
                        <RefreshCw className={cn("h-3.5 w-3.5", inventoryLoading && "animate-spin")} />
                    </Button>
                </div>

                <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
                    {inventoryError ? (
                        <div className="rounded-md border border-signal-danger/30 bg-signal-danger/10 px-3 py-2 text-xs text-signal-danger">
                            {inventoryError}
                        </div>
                    ) : null}

                    {inventory ? (
                        <>
                            <div className="rounded-md border border-border-subtle p-3 text-xs">
                                <div className="font-medium">Agent chat runtime</div>
                                <p className="mt-1 leading-relaxed text-muted-foreground">
                                    Model resolution, MCP credentials, broker/account reads, and portfolio tools stay on the backend.
                                </p>
                                <div className="mt-3 grid grid-cols-2 gap-2">
                                    <RuntimeStat label="Models" value={`${modelProviders.filter((provider) => provider.configured).length}/${modelProviders.length} configured`} />
                                    <RuntimeStat label="MCP" value={`${mcpProviders.length} provider${mcpProviders.length === 1 ? "" : "s"}`} />
                                </div>
                            </div>

                            <div className="rounded-md border border-border-subtle p-3 text-xs">
                                <div className="font-medium">Model Providers</div>
                                <div className="mt-2 space-y-2">
                                    {modelProviders.length === 0 ? (
                                        <p className="text-muted-foreground">No model providers reported.</p>
                                    ) : modelProviders.map((provider) => (
                                        <div key={provider.provider} className="rounded-md bg-muted/30 p-2">
                                            <div className="flex items-center gap-2">
                                                <span className="min-w-0 truncate font-medium">
                                                    {provider.provider === "codex" ? "Codex" : "OpenRouter"}
                                                </span>
                                                <Badge variant={provider.configured ? "outline" : "secondary"} className="ml-auto text-[10px]">
                                                    {provider.configured ? "configured" : "missing"}
                                                </Badge>
                                            </div>
                                            {provider.provider === "codex" && provider.modelIds?.length ? (
                                                <div className="mt-1 truncate font-mono text-muted-foreground">{provider.defaultModelId ?? provider.modelIds[0]}</div>
                                            ) : null}
                                            {!provider.configured && provider.reason ? (
                                                <div className="mt-1 line-clamp-2 text-signal-danger">{provider.reason}</div>
                                            ) : null}
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div className="rounded-md border border-border-subtle p-3 text-xs">
                                <div className="font-medium">MCP Providers</div>
                                <div className="mt-2 space-y-2">
                                    {mcpProviders.length === 0 ? (
                                        <p className="text-muted-foreground">No MCP providers configured.</p>
                                    ) : mcpProviders.map((provider) => (
                                        <div key={provider.id} className="rounded-md bg-muted/30 p-2">
                                            <div className="flex items-center gap-2">
                                                <span className="min-w-0 truncate font-medium">{provider.id}</span>
                                                <Badge variant={provider.status === "available" ? "outline" : "secondary"} className="ml-auto text-[10px]">
                                                    {provider.status}
                                                </Badge>
                                            </div>
                                            <div className="mt-1 text-muted-foreground">{provider.toolCount} tool{provider.toolCount === 1 ? "" : "s"}</div>
                                            {provider.error ? (
                                                <div className="mt-1 line-clamp-2 text-signal-danger">{provider.error}</div>
                                            ) : null}
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div className="rounded-md border border-border-subtle p-3 text-xs">
                                <div className="font-medium">Tools</div>
                                <div className="mt-2 space-y-2">
                                    {runtimeTools.map((toolEntry) => (
                                        <div key={toolEntry.name} className="rounded-md bg-muted/30 p-2">
                                            <div className="flex items-center gap-2">
                                                <span className="min-w-0 truncate font-medium">{toolEntry.name}</span>
                                                {toolEntry.category ? (
                                                    <Badge variant="outline" className="ml-auto text-[10px]">
                                                        {toolEntry.category}
                                                    </Badge>
                                                ) : null}
                                            </div>
                                            <p className="mt-1 line-clamp-2 text-muted-foreground">{toolEntry.description}</p>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </>
                    ) : null}
                </div>
            </aside>
        </div>
    )
}

function RuntimeStat({ label, value }: { label: string, value: string }) {
    return (
        <div className="rounded-md bg-muted/30 p-2">
            <div className="text-[10px] font-medium uppercase tracking-normal text-muted-foreground">{label}</div>
            <div className="mt-1 truncate font-medium">{value}</div>
        </div>
    )
}

function resolveDashboardChatSessionId(): string {
    if (typeof window === "undefined") {
        return "dashboard-agent-chat"
    }

    const existing = window.localStorage.getItem(CHAT_SESSION_STORAGE_KEY)
    if (existing?.trim()) {
        return existing
    }

    const generated = `dashboard-agent-chat-${crypto.randomUUID()}`
    window.localStorage.setItem(CHAT_SESSION_STORAGE_KEY, generated)
    return generated
}

function toUiMessages(messages: ServerChatMessage[]): UIMessage[] {
    return messages
        .map((message) => {
            const parts = buildServerMessageParts(message)
            if (parts.length === 0) {
                return null
            }

            return {
                id: message.messageId,
                role: message.role,
                parts,
            } satisfies UIMessage
        })
        .filter(isNonNullable)
}

function buildServerMessageParts(message: ServerChatMessage): MessagePart[] {
    const parts: MessagePart[] = []
    if (message.role === "assistant" && message.reasoning?.trim()) {
        parts.push({
            type: "reasoning",
            text: message.reasoning.trim(),
            state: "done",
        })
    }
    if (message.role === "assistant" && message.toolEvents) {
        parts.push(...toToolParts(message.toolEvents))
    }

    const text = readVisibleServerMessageText(message)
    if (text) {
        parts.push({
            type: "text",
            text,
            state: "done",
        })
    }

    return parts
}

function toToolParts(events: ServerToolEvent[]): MessagePart[] {
    const byCallId = new Map<string, ServerToolEvent[]>()
    for (const event of events) {
        const grouped = byCallId.get(event.toolCallId) ?? []
        grouped.push(event)
        byCallId.set(event.toolCallId, grouped)
    }

    return Array.from(byCallId.entries())
        .map(([toolCallId, grouped]) => {
            const inputEvent = findLastToolEvent(grouped, "input")
            const resultEvent = findLastToolEvent(grouped, "result")
            const errorEvent = findLastToolEvent(grouped, "error")
            const latest = grouped[grouped.length - 1]
            if (!latest) {
                return null
            }

            const base = {
                type: "dynamic-tool" as const,
                toolCallId,
                toolName: latest.toolName,
            }

            if (errorEvent) {
                return {
                    ...base,
                    state: "output-error" as const,
                    input: errorEvent.input ?? inputEvent?.input,
                    errorText: errorEvent.error ?? "Tool execution failed",
                } satisfies MessagePart
            }
            if (resultEvent) {
                return {
                    ...base,
                    state: "output-available" as const,
                    input: resultEvent.input ?? inputEvent?.input,
                    output: resultEvent.output,
                } satisfies MessagePart
            }
            if (inputEvent) {
                return {
                    ...base,
                    state: "input-available" as const,
                    input: inputEvent.input,
                } satisfies MessagePart
            }

            return null
        })
        .filter(isNonNullable)
}

function findLastToolEvent(events: ServerToolEvent[], state: ServerToolEvent["state"]): ServerToolEvent | undefined {
    for (let index = events.length - 1; index >= 0; index--) {
        if (events[index]?.state === state) {
            return events[index]
        }
    }

    return undefined
}

function readVisibleServerMessageText(message: ServerChatMessage): string {
    const content = message.content.trim()
    if (message.status === "failed") {
        const terminal = message.error ? `Agent chat failed: ${message.error}` : "Agent chat failed."
        return content ? `${content}\n\n${terminal}` : terminal
    }
    if (message.status === "cancelled") {
        const terminal = "Agent chat was cancelled."
        return content ? `${content}\n\n${terminal}` : terminal
    }

    if (content) {
        return content
    }

    return ""
}

function readLatestUserText(messages: UIMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]
        if (message?.role !== "user") {
            continue
        }

        const text = message.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
            .trim()

        if (text) {
            return text
        }
    }

    throw new Error("No user text message to send")
}

function readTransportModelProvider(value: unknown): AgentChatModelProvider {
    if (value === "codex" || value === "openrouter") {
        return value
    }

    throw new Error("Model provider is required before sending agent chat")
}

function readTransportModelId(value: unknown): string {
    if (typeof value !== "string") {
        throw new Error("Model id is required before sending agent chat")
    }

    const trimmed = value.trim()
    if (!trimmed) {
        throw new Error("Model id is required before sending agent chat")
    }

    return trimmed
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
    if (!headers) {
        return {}
    }
    if (headers instanceof Headers) {
        return Object.fromEntries(headers.entries())
    }
    if (Array.isArray(headers)) {
        return Object.fromEntries(headers)
    }

    return headers
}

function EmptyChat() {
    return (
        <div className="flex h-full min-h-[420px] items-center justify-center">
            <div className="w-full max-w-2xl rounded-md border border-border-subtle bg-background px-4 py-4">
                <div className="flex items-center gap-2 text-sm font-medium">
                    <Wrench className="h-4 w-4 text-primary" />
                    Agent chat ready
                </div>
                <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                    <PromptChip text="What system prompt and MCP server instructions can you see?" />
                    <PromptChip text="List available broker and portfolio read tools." />
                    <PromptChip text="Inspect MCP inventory and explain what is configured." />
                </div>
            </div>
        </div>
    )
}

function PromptChip({ text }: { text: string }) {
    return (
        <div className="rounded-md border border-border-subtle bg-muted/30 p-2 leading-relaxed">
            {text}
        </div>
    )
}

function MessageBubble({ message }: { message: UIMessage }) {
    const isUser = message.role === "user"
    const Icon = isUser ? User : Bot

    return (
        <article className={cn("flex gap-3", isUser && "justify-end")}>
            {!isUser ? (
                <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Icon className="h-4 w-4" />
                </div>
            ) : null}
            <div className={cn(
                "max-w-[min(860px,88%)] rounded-md border px-3 py-2",
                isUser
                    ? "border-primary/20 bg-primary text-primary-foreground"
                    : "border-border-subtle bg-background"
            )}>
                <div className={cn(
                    "mb-1 text-[10px] font-medium uppercase tracking-normal",
                    isUser ? "text-primary-foreground/75" : "text-muted-foreground"
                )}>
                    {message.role}
                </div>
                <div className="space-y-2">
                    {message.parts.map((part, index) => (
                        <MessagePartView key={partKey(part, index)} part={part} isUser={isUser} />
                    ))}
                </div>
            </div>
            {isUser ? (
                <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                    <Icon className="h-4 w-4" />
                </div>
            ) : null}
        </article>
    )
}

function MessagePartView({ part, isUser }: { part: MessagePart, isUser: boolean }) {
    if (part.type === "text") {
        return isUser ? (
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{part.text}</p>
        ) : (
            <MarkdownContent content={part.text} className="max-h-none bg-transparent p-0 text-sm" />
        )
    }

    if (part.type === "reasoning") {
        return (
            <details className="rounded-md border border-border-subtle bg-muted/30 p-2 text-xs">
                <summary className="cursor-pointer font-medium">Reasoning</summary>
                <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">
                    {part.text}
                </pre>
            </details>
        )
    }

    if (isToolOrDynamicToolUIPart(part)) {
        return <ToolPartView part={part} />
    }

    if (part.type === "source-url") {
        return (
            <a className="text-xs text-primary underline underline-offset-2" href={part.url} target="_blank" rel="noreferrer">
                {part.title || part.url}
            </a>
        )
    }

    return (
        <pre className="overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] text-muted-foreground">
            {formatJson(part)}
        </pre>
    )
}

function ToolPartView({ part }: { part: Extract<MessagePart, { type: "dynamic-tool" }> | MessagePart }) {
    const record = part as Record<string, unknown>
    const state = typeof record.state === "string" ? record.state : "unknown"
    const input = "input" in record ? record.input : undefined
    const output = "output" in record ? record.output : undefined
    const errorText = typeof record.errorText === "string" ? record.errorText : undefined
    const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : "unknown"
    const toolName = isToolOrDynamicToolUIPart(part) ? getToolName(part) : String(record.type)

    return (
        <details className="rounded-md border border-border-subtle bg-muted/20 p-2 text-xs" open={state !== "output-available"}>
            <summary className="flex cursor-pointer items-center gap-2 font-medium">
                <Braces className="h-3.5 w-3.5 text-primary" />
                <span className="min-w-0 truncate">{toolName}</span>
                <Badge variant={errorText ? "destructive" : "outline"} className="ml-auto text-[10px]">
                    {state}
                </Badge>
            </summary>
            <div className="mt-2 space-y-2">
                <div className="text-[10px] text-muted-foreground">{toolCallId}</div>
                {input !== undefined ? <JsonBlock label="Input" value={input} /> : null}
                {output !== undefined ? <JsonBlock label="Output" value={output} /> : null}
                {errorText ? (
                    <div className="rounded-md bg-signal-danger/10 px-2 py-1 text-signal-danger">
                        {errorText}
                    </div>
                ) : null}
            </div>
        </details>
    )
}

function JsonBlock({ label, value }: { label: string, value: unknown }) {
    return (
        <div>
            <div className="mb-1 text-[10px] font-medium uppercase tracking-normal text-muted-foreground">{label}</div>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 font-mono text-[11px]">
                {formatJson(value)}
            </pre>
        </div>
    )
}

function partKey(part: MessagePart, index: number): string {
    const record = part as Record<string, unknown>
    const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : undefined
    const sourceId = typeof record.sourceId === "string" ? record.sourceId : undefined
    return `${part.type}:${toolCallId ?? sourceId ?? index}`
}

function formatJson(value: unknown): string {
    if (value === undefined) {
        return "undefined"
    }

    if (typeof value === "string") {
        return value
    }

    return JSON.stringify(value, null, 2)
}

function isNonNullable<T>(value: T): value is NonNullable<T> {
    return value !== null && value !== undefined
}

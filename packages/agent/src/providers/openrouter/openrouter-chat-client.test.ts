import { afterEach, describe, expect, it, vi } from "vitest"
import { OpenRouterChatClient } from "./openrouter-chat-client"

const originalFetch = globalThis.fetch

describe("OpenRouterChatClient", () => {
    afterEach(() => {
        globalThis.fetch = originalFetch
    })

    it("parses streamed tool-call deltas, usage, response ids, and assistant text", async () => {
        const stream = createSseStream([
            {
                id: "or-response-1",
                choices: [{
                    delta: {
                        content: "Final ",
                    },
                }],
            },
            {
                id: "or-response-1",
                choices: [{
                    delta: {
                        content: "summary",
                        tool_calls: [{
                            index: 0,
                            id: "call-1",
                            type: "function",
                            function: {
                                name: "fake_",
                                arguments: "{\"value\"",
                            },
                        }],
                    },
                }],
            },
            {
                id: "or-response-1",
                choices: [{
                    delta: {
                        tool_calls: [{
                            index: 0,
                            function: {
                                name: "tool",
                                arguments: ":\"ok\"}",
                            },
                        }],
                    },
                    finish_reason: "tool_calls",
                }],
                usage: {
                    prompt_tokens: 11,
                    completion_tokens: 7,
                    reasoning_tokens: 3,
                    cost: 0.0123,
                },
            },
        ])
        const fetchMock = vi.fn(async () => new Response(stream, {
            status: 200,
            statusText: "OK",
        }))
        globalThis.fetch = fetchMock as unknown as typeof fetch

        const client = new OpenRouterChatClient({
            apiKey: "test-key",
            model: "test-model",
            baseUrl: "https://openrouter.test",
            requestTimeoutMs: 10_000,
            streamStallTimeoutMs: 10_000,
        })
        const response = await client.chat([{
            role: "user",
            content: "run",
        }], undefined, undefined, 1)

        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(response.content).toBe("Final summary")
        expect(response.finishReason).toBe("tool_calls")
        expect(response.toolCalls).toEqual([{
            id: "call-1",
            type: "function",
            function: {
                name: "fake_tool",
                arguments: "{\"value\":\"ok\"}",
            },
        }])
        expect(response.usage).toMatchObject({
            promptTokens: 11,
            completionTokens: 7,
            reasoningTokens: 3,
            cost: 0.0123,
            responseIds: ["or-response-1"],
        })
    })

    it("keeps interleaved streamed tool calls separated by index", async () => {
        const stream = createSseStream([
            {
                id: "or-response-tools",
                choices: [{
                    delta: {
                        tool_calls: [
                            {
                                index: 0,
                                id: "call-first",
                                type: "function",
                                function: {
                                    name: "first_",
                                    arguments: "{\"side\"",
                                },
                            },
                            {
                                index: 1,
                                id: "call-second",
                                type: "function",
                                function: {
                                    name: "second_",
                                    arguments: "{\"side\"",
                                },
                            },
                        ],
                    },
                }],
            },
            {
                id: "or-response-tools",
                choices: [{
                    delta: {
                        tool_calls: [
                            {
                                index: 1,
                                function: {
                                    name: "tool",
                                    arguments: ":\"sell\"}",
                                },
                            },
                            {
                                index: 0,
                                function: {
                                    name: "tool",
                                    arguments: ":\"buy\"}",
                                },
                            },
                        ],
                    },
                    finish_reason: "tool_calls",
                }],
            },
        ])
        globalThis.fetch = vi.fn(async () => new Response(stream, {
            status: 200,
            statusText: "OK",
        })) as unknown as typeof fetch

        const client = new OpenRouterChatClient({
            apiKey: "test-key",
            model: "test-model",
            baseUrl: "https://openrouter.test",
            requestTimeoutMs: 10_000,
            streamStallTimeoutMs: 10_000,
        })
        const response = await client.chat([{
            role: "user",
            content: "run",
        }], undefined, undefined, 1)

        expect(response.toolCalls).toEqual([
            {
                id: "call-first",
                type: "function",
                function: {
                    name: "first_tool",
                    arguments: "{\"side\":\"buy\"}",
                },
            },
            {
                id: "call-second",
                type: "function",
                function: {
                    name: "second_tool",
                    arguments: "{\"side\":\"sell\"}",
                },
            },
        ])
    })

    it("fails closed on streamed tool calls without an index", async () => {
        const stream = createSseStream([
            {
                id: "or-response-malformed",
                choices: [{
                    delta: {
                        tool_calls: [{
                            id: "call-missing-index",
                            type: "function",
                            function: {
                                name: "unsafe_tool",
                                arguments: "{}",
                            },
                        }],
                    },
                }],
            },
        ])
        globalThis.fetch = vi.fn(async () => new Response(stream, {
            status: 200,
            statusText: "OK",
        })) as unknown as typeof fetch

        const client = new OpenRouterChatClient({
            apiKey: "test-key",
            model: "test-model",
            baseUrl: "https://openrouter.test",
            requestTimeoutMs: 10_000,
            streamStallTimeoutMs: 10_000,
        })

        await expect(client.chat([{
            role: "user",
            content: "run",
        }], undefined, undefined, 1)).rejects.toThrow("missing a valid index")
    })

    it("processes finish-only terminal chunks without a trailing newline", async () => {
        const stream = createRawSseStream([
            `data: ${JSON.stringify({
                id: "or-response-final",
                choices: [{
                    delta: {
                        content: "Done",
                    },
                }],
            })}`,
            `data: ${JSON.stringify({
                id: "or-response-final",
                choices: [{
                    finish_reason: "stop",
                }],
                usage: {
                    prompt_tokens: 3,
                    completion_tokens: 2,
                    reasoning_tokens: 1,
                    cost: 0.001,
                },
            })}`,
        ].join("\n"))
        const fetchMock = vi.fn(async () => new Response(stream, {
            status: 200,
            statusText: "OK",
        }))
        globalThis.fetch = fetchMock as unknown as typeof fetch

        const client = new OpenRouterChatClient({
            apiKey: "test-key",
            model: "test-model",
            baseUrl: "https://openrouter.test",
            requestTimeoutMs: 10_000,
            streamStallTimeoutMs: 10_000,
        })
        const response = await client.chat([{
            role: "user",
            content: "run",
        }], undefined, undefined, 1)

        expect(response.content).toBe("Done")
        expect(response.finishReason).toBe("stop")
        expect(response.usage).toMatchObject({
            promptTokens: 3,
            completionTokens: 2,
            reasoningTokens: 1,
            cost: 0.001,
            responseIds: ["or-response-final"],
        })
    })
})

function createSseStream(chunks: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    const body = chunks
        .map((chunk) => `data: ${JSON.stringify(chunk)}\n`)
        .join("\n") + "\ndata: [DONE]\n"

    return new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(body))
            controller.close()
        },
    })
}

function createRawSseStream(body: string): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()

    return new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(body))
            controller.close()
        },
    })
}

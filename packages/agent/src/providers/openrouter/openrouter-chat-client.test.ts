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

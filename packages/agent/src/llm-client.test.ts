import { afterEach, describe, expect, it, vi } from "vitest"
import { LLMClient } from "./llm-client"

describe("LLMClient", () => {
    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it("sends OpenRouter reasoning config with GPT-5.5 requests", async () => {
        let requestBody: Record<string, unknown> | undefined
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode("data: {\"choices\":[{\"delta\":{\"content\":\"done\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"reasoning_tokens\":3}}\n\n"))
                controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
                controller.close()
            },
        })

        vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
            requestBody = JSON.parse(String(init?.body))
            return new Response(stream, { status: 200 })
        }))

        const client = new LLMClient({
            apiKey: "key",
            model: "openai/gpt-5.5",
            reasoning: {
                effort: "medium",
                exclude: true,
            },
        })

        const response = await client.chat([
            {
                role: "user",
                content: "hello",
            },
        ])

        expect(requestBody).toMatchObject({
            model: "openai/gpt-5.5",
            reasoning: {
                effort: "medium",
                exclude: true,
            },
        })
        expect(response.usage.reasoningTokens).toBe(3)
    })
})

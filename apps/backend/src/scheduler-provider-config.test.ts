import { describe, expect, it } from "vitest"
import { createAgentProviderConfig } from "./scheduler-provider-config"

describe("createAgentProviderConfig", () => {
    it("maps OpenRouter provider config from Convex secrets", () => {
        const config = createAgentProviderConfig(
            {
                provider: "openrouter",
                model: "openrouter/test",
                reasoning: {
                    effort: "medium",
                    exclude: true,
                },
            },
            {
                OPENROUTER_API_KEY: "openrouter-key",
            },
            {}
        )

        expect(config).toEqual({
            provider: "openrouter",
            apiKey: "openrouter-key",
            model: "openrouter/test",
            reasoning: {
                effort: "medium",
                exclude: true,
            },
            baseUrl: undefined,
        })
    })

    it("does not pass Codex credentials through scheduled provider config", () => {
        expect(createAgentProviderConfig(
            {
                provider: "codex",
                model: "gpt-5.4",
                authMode: "chatgpt",
            },
            {
                CODEX_ACCESS_TOKEN: "convex-token",
                OPENAI_API_KEY: null,
            },
            {
                CODEX_ACCESS_TOKEN: "env-token",
                OPENAI_API_KEY: "env-api-key",
            }
        )).toMatchObject({
            provider: "codex",
            authMode: "chatgpt",
        })
        expect(createAgentProviderConfig(
            {
                provider: "codex",
                model: "gpt-5.4",
                authMode: "chatgpt",
            },
            {
                CODEX_ACCESS_TOKEN: "convex-token",
                OPENAI_API_KEY: null,
            },
            {
                CODEX_ACCESS_TOKEN: "env-token",
                OPENAI_API_KEY: "env-api-key",
            }
        )).not.toHaveProperty("codexAccessToken")
    })
})

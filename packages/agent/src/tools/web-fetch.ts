import { z } from "zod"
import type { ToolBinding } from "../tool-registry"
import {
    createToolBinding,
    webFetchParamsSchema,
} from "../tool-contracts"

const FETCH_TIMEOUT_MS = 15_000

export function createWebFetchTool(): ToolBinding {
    return createToolBinding({
        name: "web_fetch",
        venue: "polymarket",
        handler: async (params) => {
            const validated = params as z.infer<typeof webFetchParamsSchema>

            const controller = new AbortController()
            const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

            try {
                const response = await fetch(validated.url, {
                    signal: controller.signal,
                    headers: {
                        "User-Agent": "ValiqTradingAgent/1.0",
                        "Accept": "text/html, application/json, text/plain",
                    },
                })

                clearTimeout(timeoutId)

                if (!response.ok) {
                    return {
                        error: `HTTP ${response.status} ${response.statusText}`,
                        url: validated.url,
                    }
                }

                const contentType = response.headers.get("content-type") ?? ""
                const rawText = await response.text()

                let content: string
                if (contentType.includes("text/html")) {
                    content = stripHtml(rawText)
                } else {
                    content = rawText
                }

                if (content.length > validated.maxLength) {
                    content = content.slice(0, validated.maxLength) + "\n[truncated]"
                }

                return {
                    url: validated.url,
                    content,
                    length: content.length,
                }
            } catch (error) {
                clearTimeout(timeoutId)
                const errorMsg = error instanceof Error ? error.message : String(error)
                return {
                    error: `Fetch failed: ${errorMsg}`,
                    url: validated.url,
                }
            }
        },
    })
}

function stripHtml(html: string): string {
    return html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim()
}

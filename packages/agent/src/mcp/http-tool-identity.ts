import { createHash } from "node:crypto"
import { stableJsonKey } from "./stable-json"

const MAX_OPENROUTER_TOOL_NAME_LENGTH = 64

export function sanitizeToolNamePart(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "")
}

export function buildMcpToolName(
    providerPart: string,
    toolPart: string,
    rawProviderId: string,
    rawToolName: string
): string {
    const baseName = `mcp_${providerPart}_${toolPart}`
    const sanitizationChanged = providerPart !== rawProviderId || toolPart !== rawToolName
    if (!sanitizationChanged && isValidOpenRouterToolName(baseName)) {
        return baseName
    }

    const hash = createHash("sha256")
        .update(`${rawProviderId}\0${rawToolName}`)
        .digest("hex")
        .slice(0, 10)
    const prefix = "mcp_"
    const separatorLength = 2
    const available = MAX_OPENROUTER_TOOL_NAME_LENGTH - prefix.length - separatorLength - hash.length
    const providerLength = Math.max(8, Math.floor(available * 0.4))
    const toolLength = Math.max(8, available - providerLength)
    const shortened = `${prefix}${providerPart.slice(0, providerLength)}_${toolPart.slice(0, toolLength)}_${hash}`

    if (!isValidOpenRouterToolName(shortened)) {
        throw new Error(`MCP tool name could not be made OpenRouter-compatible for provider ${rawProviderId} tool ${rawToolName}`)
    }

    return shortened
}

export function hashMcpToolSchema(schema: Record<string, unknown>): string {
    return createHash("sha256")
        .update(stableJsonKey(schema))
        .digest("hex")
}

function isValidOpenRouterToolName(value: string): boolean {
    return value.length > 0 &&
        value.length <= MAX_OPENROUTER_TOOL_NAME_LENGTH &&
        /^[a-zA-Z0-9_-]+$/.test(value)
}

import type { McpToolDiscoveryRequest } from "./http-tool-types"

export function mcpDiscoveryRequestKey(request: Pick<McpToolDiscoveryRequest, "providerId" | "toolName" | "input">): string {
    return `${request.providerId}\0${request.toolName}\0${stableMcpJsonKey(request.input)}`
}

export function mcpProviderDiscoveryToolKey(toolName: string, input: Record<string, unknown>): string {
    return `${toolName}\0${stableMcpJsonKey(input)}`
}

export function stableMcpJsonKey(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map((entry) => stableMcpJsonKey(entry)).join(",")}]`
    }
    if (value && typeof value === "object") {
        return `{${Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => `${JSON.stringify(key)}:${stableMcpJsonKey(entry)}`)
            .join(",")}}`
    }

    return JSON.stringify(value)
}

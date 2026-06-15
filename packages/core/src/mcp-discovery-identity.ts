import { stableJsonKey } from "./stable-json"

export type McpDiscoveryIdentityRequest = {
    providerId: string
    toolName: string
    input: Record<string, unknown>
}

export function mcpDiscoveryRequestKey(request: Pick<McpDiscoveryIdentityRequest, "providerId" | "toolName" | "input">): string {
    return `${request.providerId}\0${request.toolName}\0${stableJsonKey(request.input)}`
}

export function mcpProviderDiscoveryToolKey(toolName: string, input: Record<string, unknown>): string {
    return `${toolName}\0${stableJsonKey(input)}`
}

export function stableMcpJsonKey(value: unknown): string {
    return stableJsonKey(value)
}

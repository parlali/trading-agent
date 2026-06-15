import type {
    HttpMcpProviderConfig,
    McpNestedDiscoveryToolConfig,
    McpToolApproval,
    McpToolDiscoveryRequest,
} from "./http-tool-types"
import { mcpProviderDiscoveryToolKey } from "./discovery-request-identity"

export function createScopedMcpProviderConfig(args: {
    provider: HttpMcpProviderConfig
    tools: readonly McpToolApproval[]
    discoveryRequests?: readonly McpToolDiscoveryRequest[]
}): HttpMcpProviderConfig {
    const discoveryTools = mergeMcpDiscoveryToolConfigs(
        args.provider.discoveryTools,
        args.discoveryRequests ?? []
    )

    return {
        ...args.provider,
        allowedTools: args.tools.map((tool) => tool.toolName),
        approvedTools: args.tools.map((tool) => ({
            name: tool.toolName,
            registeredName: tool.registeredName,
            schemaHash: tool.schemaHash,
        })),
        ...(discoveryTools.length > 0 ? { discoveryTools } : {}),
    }
}

export function mergeMcpDiscoveryToolConfigs(
    baseDiscoveryTools: readonly McpNestedDiscoveryToolConfig[] | undefined,
    discoveryRequests: readonly McpToolDiscoveryRequest[]
): McpNestedDiscoveryToolConfig[] {
    const seen = new Set<string>()
    const inputsByToolName = new Map<string, Record<string, unknown>[]>()

    for (const discoveryTool of baseDiscoveryTools ?? []) {
        for (const input of discoveryTool.inputs) {
            appendDiscoveryInput({
                toolName: discoveryTool.name,
                input,
                seen,
                inputsByToolName,
            })
        }
    }

    for (const request of discoveryRequests) {
        appendDiscoveryInput({
            toolName: request.toolName,
            input: request.input,
            seen,
            inputsByToolName,
        })
    }

    return Array.from(inputsByToolName.entries()).map(([name, inputs]) => ({
        name,
        inputs,
    }))
}

function appendDiscoveryInput(args: {
    toolName: string
    input: Record<string, unknown>
    seen: Set<string>
    inputsByToolName: Map<string, Record<string, unknown>[]>
}): void {
    const key = mcpProviderDiscoveryToolKey(args.toolName, args.input)
    if (args.seen.has(key)) {
        return
    }

    args.seen.add(key)
    const inputs = args.inputsByToolName.get(args.toolName) ?? []
    inputs.push(args.input)
    args.inputsByToolName.set(args.toolName, inputs)
}

import {
    createScopedMcpProviderConfig,
} from "@valiq-trading/agent/mcp/provider-scope"
import type {
    HttpMcpProviderConfig,
    McpToolApproval,
    McpToolDiscoveryRequest,
} from "@valiq-trading/agent/mcp/http-tools"

interface McpConnectionWhitelistScope {
    tools: McpToolApproval[]
    discoveryTools?: McpToolDiscoveryRequest[]
}

export function createMcpConnectionProviderScope(
    providers: HttpMcpProviderConfig[],
    whitelist: McpConnectionWhitelistScope
): {
    providers: HttpMcpProviderConfig[]
    missingProviderIds: string[]
} {
    const providerById = new Map(providers.map((provider) => [provider.id, provider]))
    const toolsByProvider = new Map<string, McpToolApproval[]>()

    for (const tool of whitelist.tools) {
        const providerTools = toolsByProvider.get(tool.providerId) ?? []
        providerTools.push(tool)
        toolsByProvider.set(tool.providerId, providerTools)
    }

    const missingProviderIds = Array.from(toolsByProvider.keys())
        .filter((providerId) => !providerById.has(providerId))
        .sort((left, right) => left.localeCompare(right))
    const scopedProviders = Array.from(toolsByProvider).flatMap(([providerId, providerTools]) => {
        const provider = providerById.get(providerId)
        if (!provider) {
            return []
        }

        return [createScopedMcpProviderConfig({
            provider,
            tools: providerTools,
            discoveryRequests: (whitelist.discoveryTools ?? []).filter((request) => request.providerId === providerId),
        })]
    })

    return {
        providers: scopedProviders,
        missingProviderIds,
    }
}

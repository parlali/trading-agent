import type {
    HttpMcpProviderConfig,
    McpToolApproval,
} from "@valiq-trading/agent"

export function createMcpConnectionProviderScope(
    providers: HttpMcpProviderConfig[],
    tools: McpToolApproval[]
): {
    providers: HttpMcpProviderConfig[]
    missingProviderIds: string[]
} {
    const providerById = new Map(providers.map((provider) => [provider.id, provider]))
    const toolsByProvider = new Map<string, McpToolApproval[]>()

    for (const tool of tools) {
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

        return [{
            ...provider,
            allowedTools: providerTools.map((tool) => tool.toolName),
            approvedTools: providerTools.map((tool) => ({
                name: tool.toolName,
                registeredName: tool.registeredName,
                schemaHash: tool.schemaHash,
            })),
        }]
    })

    return {
        providers: scopedProviders,
        missingProviderIds,
    }
}

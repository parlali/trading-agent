import { action } from "./_generated/server"
import { v } from "convex/values"
import {
    MCP_PROVIDER_SECRET_KEYS,
    discoverHttpMcpToolInventory,
    resolveMcpProviderConfigs,
} from "@valiq-trading/agent"
import { readConvexEnv, requireServiceToken, requireUser } from "./lib/authGuards"

export const resolveSecrets = action({
    args: {
        keys: v.array(v.string()),
        serviceToken: v.string(),
    },
    handler: async (_ctx, args) => {
        requireServiceToken(args.serviceToken)

        const resolved: Record<string, string | null> = {}
        const env = readConvexEnv()

        for (const key of args.keys) {
            resolved[key] = env[key] ?? null
        }

        return resolved
    },
})

export const discoverMcpToolInventory = action({
    args: {},
    handler: async (ctx) => {
        await requireUser(ctx)

        const secrets = readMcpConnectionSecrets()
        let providers: ReturnType<typeof resolveMcpProviderConfigs>

        try {
            providers = resolveMcpProviderConfigs({
                secrets,
            })
        } catch (error) {
            return {
                providers: [{
                    id: "mcp_configuration",
                    toolCount: 0,
                    skippedCount: 1,
                    status: "unavailable" as const,
                    error: error instanceof Error ? error.message : "MCP provider configuration is unavailable",
                }],
                tools: [],
                diagnostics: [{
                    providerId: "mcp_configuration",
                    reason: "provider_unavailable" as const,
                    message: error instanceof Error ? error.message : "MCP provider configuration is unavailable",
                }],
            }
        }

        if (providers.length === 0) {
            return {
                providers: [],
                tools: [],
                diagnostics: [],
            }
        }

        const resolution = await discoverHttpMcpToolInventory({
            providers,
            failOnProviderError: false,
        })
        const toolsByProvider = countByProvider(resolution.inventory.map((tool) => tool.providerId))
        const skippedByProvider = countByProvider(resolution.diagnostics.map((diagnostic) => diagnostic.providerId))
        const providerIds = new Set(providers.map((provider) => provider.id))
        for (const diagnostic of resolution.diagnostics) {
            providerIds.add(diagnostic.providerId)
        }

        return {
            providers: Array.from(providerIds).sort((left, right) => left.localeCompare(right)).map((providerId) => {
                const providerUnavailable = resolution.diagnostics.some((diagnostic) =>
                    diagnostic.providerId === providerId && diagnostic.reason === "provider_unavailable"
                )

                return {
                    id: providerId,
                    toolCount: toolsByProvider.get(providerId) ?? 0,
                    skippedCount: skippedByProvider.get(providerId) ?? 0,
                    status: providerUnavailable ? "unavailable" as const : "available" as const,
                    error: providerUnavailable
                        ? resolution.diagnostics.find((diagnostic) => diagnostic.providerId === providerId)?.message
                        : undefined,
                }
            }),
            tools: resolution.inventory,
            diagnostics: resolution.diagnostics,
        }
    },
})

function readMcpConnectionSecrets(): Record<string, string | null> {
    const secrets: Record<string, string | null> = {}
    const env = readConvexEnv()

    for (const key of MCP_PROVIDER_SECRET_KEYS) {
        secrets[key] = env[key] ?? null
    }

    return secrets
}

function countByProvider(providerIds: string[]): Map<string, number> {
    const counts = new Map<string, number>()

    for (const providerId of providerIds) {
        counts.set(providerId, (counts.get(providerId) ?? 0) + 1)
    }

    return counts
}

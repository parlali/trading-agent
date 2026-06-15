import { action } from "./_generated/server"
import { internal } from "./_generated/api"
import { v } from "convex/values"
import {
    MCP_PROVIDER_SECRET_KEYS,
    discoverHttpMcpToolInventory,
    resolveMcpProviderConfigs,
    type McpToolApproval,
    type McpToolDiagnostic,
    type McpToolInventoryEntry,
} from "@valiq-trading/agent"
import type { Id } from "./_generated/dataModel"
import { readConvexEnv, requireServiceToken, requireUser } from "./lib/authGuards"
import { mcpToolApprovalV } from "./lib/validators"

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

export const setStrategyMcpToolWhitelist = action({
    args: {
        strategyId: v.id("strategies"),
        tools: v.array(mcpToolApprovalV),
        approvalReason: v.optional(v.string()),
    },
    handler: async (ctx, args): Promise<{
        whitelistId: Id<"strategy_mcp_tool_whitelists">
        toolCount: number
        diagnostics: McpToolDiagnostic[]
    }> => {
        const approvedBy = await readRequiredUserActor(ctx)
        const inventory = await discoverCurrentMcpInventory()
        const inventoryByKey = new Map(inventory.tools.map((tool) => [mcpToolKey(tool.providerId, tool.upstreamToolName), tool]))
        const now = Date.now()
        const approvals: McpToolApproval[] = []

        for (const requestedTool of args.tools) {
            const inventoryTool = inventoryByKey.get(mcpToolKey(requestedTool.providerId, requestedTool.toolName))
            if (!inventoryTool) {
                throw new Error(`MCP whitelist tool is not present in current provider inventory: ${requestedTool.providerId}:${requestedTool.toolName}`)
            }
            if (requestedTool.registeredName !== inventoryTool.registeredName) {
                throw new Error(`MCP whitelist registeredName is stale for ${requestedTool.providerId}:${requestedTool.toolName}`)
            }
            if (requestedTool.schemaHash !== inventoryTool.schemaHash) {
                throw new Error(`MCP whitelist schemaHash is stale for ${requestedTool.providerId}:${requestedTool.toolName}`)
            }

            approvals.push({
                providerId: inventoryTool.providerId,
                toolName: inventoryTool.upstreamToolName,
                registeredName: inventoryTool.registeredName,
                schemaHash: inventoryTool.schemaHash,
                description: inventoryTool.description,
                source: inventoryTool.source,
                inputSchema: inventoryTool.inputSchema,
                approvedAt: now,
                approvedBy,
                approvalReason: args.approvalReason?.trim() || undefined,
            })
        }

        const whitelistId = await ctx.runMutation(internal.mutations.setStrategyMcpToolWhitelistInternal, {
            strategyId: args.strategyId,
            tools: approvals,
        }) as Id<"strategy_mcp_tool_whitelists">

        return {
            whitelistId,
            toolCount: approvals.length,
            diagnostics: inventory.diagnostics,
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

async function discoverCurrentMcpInventory(): Promise<{
    tools: McpToolInventoryEntry[]
    diagnostics: McpToolDiagnostic[]
}> {
    const providers = resolveMcpProviderConfigs({
        secrets: readMcpConnectionSecrets(),
    })
    if (providers.length === 0) {
        throw new Error("No MCP provider configured. Set MCP_PROVIDER_CONFIGS or MCP_SERVER_URL in Convex environment variables")
    }

    const inventory = await discoverHttpMcpToolInventory({
        providers,
        failOnProviderError: false,
    })
    if (inventory.diagnostics.some((diagnostic) => diagnostic.reason === "provider_unavailable")) {
        throw new Error("MCP provider inventory is unavailable; whitelist changes were not persisted")
    }

    return {
        tools: inventory.inventory,
        diagnostics: inventory.diagnostics,
    }
}

async function readRequiredUserActor(ctx: { auth: { getUserIdentity: () => Promise<unknown> } }): Promise<string> {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) {
        throw new Error("Authentication required")
    }

    if (identity && typeof identity === "object") {
        const record = identity as Record<string, unknown>
        const candidate = readNonEmptyString(record.subject) ??
            readNonEmptyString(record.email) ??
            readNonEmptyString(record.name)
        if (candidate) {
            return candidate
        }
    }

    return "authenticated-user"
}

function readNonEmptyString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : undefined
}

function mcpToolKey(providerId: string, toolName: string): string {
    return `${providerId}\0${toolName}`
}

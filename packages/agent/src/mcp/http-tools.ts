import { z } from "zod"
import type { ToolBinding } from "../tool-registry"
import { withCallBudget } from "../tools/with-call-budget"
import { HttpMcpClient, type HttpMcpTool } from "./http-client"
import {
    buildApprovedToolMap,
    createCandidateForRemoteTool,
    type McpToolCandidate,
} from "./http-tool-candidates"
import {
    DEFAULT_MCP_MAX_TOOLS_PER_PROVIDER,
    discoverProviderRemoteTools,
} from "./http-tool-discovery"
import { hashMcpToolSchema } from "./http-tool-identity"
import { sanitizeMcpError } from "./mcp-error-sanitizer"
import type {
    CreateHttpMcpToolBindingsConfig,
    HttpMcpProviderConfig,
    HttpMcpToolBindingResolution,
    McpToolDiagnostic,
    McpToolInventoryEntry,
} from "./http-tool-types"

export { hashMcpToolSchema } from "./http-tool-identity"
export type {
    CreateHttpMcpToolBindingsConfig,
    HttpMcpProviderConfig,
    HttpMcpToolBindingResolution,
    McpApprovedTool,
    McpNestedDiscoveryToolConfig,
    McpToolApproval,
    McpToolDiagnostic,
    McpToolDiscoverySource,
    McpToolInventoryEntry,
    McpToolSkipReason,
} from "./http-tool-types"

const remoteMcpParamsSchema = z.record(z.string(), z.unknown())

export async function createHttpMcpToolBindings(
    config: CreateHttpMcpToolBindingsConfig
): Promise<ToolBinding[]> {
    const resolution = await createHttpMcpToolBindingResolution(config)
    return resolution.bindings
}

export async function createHttpMcpToolBindingResolution(
    config: CreateHttpMcpToolBindingsConfig
): Promise<HttpMcpToolBindingResolution> {
    const bindings: ToolBinding[] = []
    const inventory: McpToolInventoryEntry[] = []
    const diagnostics: McpToolDiagnostic[] = []
    const registeredNames = new Set<string>()

    for (const provider of config.providers) {
        const providerResolution = await resolveProviderTools({
            provider,
            config,
            requireWhitelist: true,
        })
        inventory.push(...providerResolution.inventory)
        diagnostics.push(...providerResolution.diagnostics)

        for (const resolvedTool of providerResolution.resolvedTools) {
            if (registeredNames.has(resolvedTool.binding.name)) {
                diagnostics.push({
                    providerId: provider.id,
                    upstreamToolName: resolvedTool.inventory.upstreamToolName,
                    registeredName: resolvedTool.binding.name,
                    source: resolvedTool.inventory.source,
                    reason: "duplicate_registered_name",
                    message: "MCP tool skipped because its registered name duplicates another MCP tool",
                })
                continue
            }

            registeredNames.add(resolvedTool.binding.name)
            bindings.push(resolvedTool.binding)
        }

        config.logger?.info("MCP provider tools registered", {
            providerId: provider.id,
            registeredTools: providerResolution.resolvedTools.length,
            skippedTools: providerResolution.diagnostics.length,
        })
    }

    return {
        bindings,
        inventory,
        diagnostics,
    }
}

export async function discoverHttpMcpToolInventory(
    config: CreateHttpMcpToolBindingsConfig
): Promise<Pick<HttpMcpToolBindingResolution, "inventory" | "diagnostics">> {
    const inventory: McpToolInventoryEntry[] = []
    const diagnostics: McpToolDiagnostic[] = []

    for (const provider of config.providers) {
        const providerResolution = await resolveProviderTools({
            provider,
            config,
            requireWhitelist: false,
        })
        inventory.push(...providerResolution.inventory)
        diagnostics.push(...providerResolution.diagnostics)
    }

    return {
        inventory,
        diagnostics,
    }
}

export function withMcpToolCallBudget(tool: ToolBinding, maxCalls: number): ToolBinding {
    return tool.contractOwner?.startsWith("mcp:") === true
        ? withCallBudget(tool, maxCalls)
        : tool
}

function createBindingForCandidate(args: {
    provider: HttpMcpProviderConfig
    remoteTool: HttpMcpTool
    candidate: McpToolCandidate
    client: HttpMcpClient
}): ToolBinding {
    return {
        name: args.candidate.inventory.registeredName,
        description: args.candidate.inventory.description,
        parameters: remoteMcpParamsSchema,
        jsonSchema: args.candidate.inputSchema,
        category: args.provider.category ?? "research",
        compatibleVenues: args.provider.compatibleVenues,
        contractBoundary: "shared",
        contractOwner: `mcp:${args.provider.id}`,
        outputDescription: "Returns the upstream MCP tool result.",
        errorSemantics: "Remote MCP validation, transport, and provider errors throw and are handled by the registered tool category.",
        handler: async (params, context) => {
            return await args.client.callTool(args.remoteTool.name, params, context?.signal)
        },
    }
}

async function resolveProviderTools(args: {
    provider: HttpMcpProviderConfig
    config: CreateHttpMcpToolBindingsConfig
    requireWhitelist: boolean
}): Promise<{
    inventory: McpToolInventoryEntry[]
    diagnostics: McpToolDiagnostic[]
    resolvedTools: Array<{ binding: ToolBinding, inventory: McpToolInventoryEntry }>
}> {
    const diagnostics: McpToolDiagnostic[] = []
    const inventory: McpToolInventoryEntry[] = []
    const resolvedTools: Array<{ binding: ToolBinding, inventory: McpToolInventoryEntry }> = []
    const client = new HttpMcpClient({
        id: args.provider.id,
        url: args.provider.url,
        token: args.provider.token,
        timeoutMs: args.provider.timeoutMs,
        maxListPages: args.provider.maxListPages,
        logger: args.config.logger,
    })
    const maxTools = args.provider.maxTools ?? DEFAULT_MCP_MAX_TOOLS_PER_PROVIDER
    let remoteTools: Array<{ tool: HttpMcpTool, source: McpToolInventoryEntry["source"] }>

    try {
        remoteTools = await discoverProviderRemoteTools({
            provider: args.provider,
            client,
            maxTools,
            signal: args.config.signal,
            includeNestedDiscovery: args.config.includeNestedDiscovery !== false,
            logger: args.config.logger,
            diagnostics,
        })
    } catch (error) {
        if (args.config.failOnProviderError !== false) {
            throw error
        }

        diagnostics.push({
            providerId: args.provider.id,
            reason: "provider_unavailable",
            message: sanitizeMcpError(error),
        })

        return {
            inventory,
            diagnostics,
            resolvedTools,
        }
    }

    const approvedTools = buildApprovedToolMap(args.provider)
    const discoveredToolNames = new Set<string>()

    for (const remoteTool of remoteTools) {
        discoveredToolNames.add(remoteTool.tool.name)
        const candidate = createCandidateForRemoteTool({
            provider: args.provider,
            remoteTool: remoteTool.tool,
            source: remoteTool.source,
        })

        if ("diagnostic" in candidate) {
            diagnostics.push(candidate.diagnostic)
            continue
        }

        inventory.push(candidate.inventory)

        if (!args.requireWhitelist) {
            continue
        }

        const approvedTool = approvedTools.get(remoteTool.tool.name)
        if (!approvedTool) {
            diagnostics.push({
                providerId: args.provider.id,
                upstreamToolName: remoteTool.tool.name,
                registeredName: candidate.inventory.registeredName,
                source: remoteTool.source,
                reason: "not_whitelisted",
                message: "MCP tool skipped because it is not whitelisted for this strategy",
            })
            continue
        }

        if (approvedTool.schemaHash && approvedTool.schemaHash !== candidate.inventory.schemaHash) {
            diagnostics.push({
                providerId: args.provider.id,
                upstreamToolName: remoteTool.tool.name,
                registeredName: candidate.inventory.registeredName,
                source: remoteTool.source,
                reason: "schema_changed",
                message: "MCP tool skipped because its discovered input schema hash no longer matches the approved schema hash",
                schemaReason: `expected ${approvedTool.schemaHash}, discovered ${candidate.inventory.schemaHash}`,
            })
            continue
        }

        if (approvedTool.registeredName && approvedTool.registeredName !== candidate.inventory.registeredName) {
            diagnostics.push({
                providerId: args.provider.id,
                upstreamToolName: remoteTool.tool.name,
                registeredName: candidate.inventory.registeredName,
                source: remoteTool.source,
                reason: "registered_name_changed",
                message: "MCP tool skipped because its registered tool name no longer matches the approved name",
            })
            continue
        }

        resolvedTools.push({
            binding: createBindingForCandidate({
                provider: args.provider,
                remoteTool: remoteTool.tool,
                candidate,
                client,
            }),
            inventory: candidate.inventory,
        })
    }

    if (args.requireWhitelist) {
        for (const approvedTool of approvedTools.values()) {
            if (!discoveredToolNames.has(approvedTool.name)) {
                diagnostics.push({
                    providerId: args.provider.id,
                    upstreamToolName: approvedTool.name,
                    registeredName: approvedTool.registeredName,
                    reason: "tool_disappeared",
                    message: "MCP tool skipped because the approved upstream tool was not discovered from the provider",
                })
            }
        }
    }

    return {
        inventory,
        diagnostics,
        resolvedTools,
    }
}

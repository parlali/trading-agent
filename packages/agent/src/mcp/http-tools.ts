import { z } from "zod"
import type { ToolBinding } from "../tool-registry"
import { withCallBudget } from "../tools/with-call-budget"
import { HttpMcpClient, type HttpMcpTool, type ToolsCallResult } from "./http-client"
import {
    buildApprovedToolMap,
    createCandidateForRemoteTool,
    type McpToolCandidate,
} from "./http-tool-candidates"
import {
    appendDeduplicatedMcpTool,
    createMcpToolDeduplicationState,
} from "./http-tool-duplicates"
import {
    DEFAULT_MCP_MAX_TOOLS_PER_PROVIDER,
    appendMcpToolParseIssueDiagnostics,
    discoverProviderRemoteTools,
    isNestedDiscoveryTool,
    readNestedDiscoveredTools,
    type DiscoveredRemoteTool,
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
    McpToolAnnotations,
    McpToolApproval,
    McpToolDiagnostic,
    McpToolDiscoveryRequest,
    McpToolDiscoverySource,
    McpToolInventoryEntry,
    McpToolSkipReason,
} from "./http-tool-types"

const remoteMcpParamsSchema = z.record(z.string(), z.unknown())

interface ResolvedProviderTools {
    inventory: McpToolInventoryEntry[]
    diagnostics: McpToolDiagnostic[]
    resolvedTools: Array<{ binding: ToolBinding, inventory: McpToolInventoryEntry }>
}

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
            emitDisappearedDiagnostics: true,
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
            emitDisappearedDiagnostics: false,
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
    dynamicRefresh?: (result: ToolsCallResult) => Promise<void>
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
            const result = await args.client.callTool(args.remoteTool.name, params, context?.signal)
            if (args.dynamicRefresh) {
                await args.dynamicRefresh(result)
            }
            return result
        },
    }
}

async function resolveProviderTools(args: {
    provider: HttpMcpProviderConfig
    config: CreateHttpMcpToolBindingsConfig
    requireWhitelist: boolean
    emitDisappearedDiagnostics: boolean
}): Promise<ResolvedProviderTools> {
    const diagnostics: McpToolDiagnostic[] = []
    const client = new HttpMcpClient({
        id: args.provider.id,
        url: args.provider.url,
        token: args.provider.token,
        timeoutMs: args.provider.timeoutMs,
        maxListPages: args.provider.maxListPages,
        logger: args.config.logger,
    })
    const maxTools = args.provider.maxTools ?? DEFAULT_MCP_MAX_TOOLS_PER_PROVIDER
    let remoteTools: DiscoveredRemoteTool[]

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
            inventory: [],
            diagnostics,
            resolvedTools: [],
        }
    }

    const resolved = resolveRemoteToolBindings({
        provider: args.provider,
        config: args.config,
        requireWhitelist: args.requireWhitelist,
        emitDisappearedDiagnostics: args.emitDisappearedDiagnostics,
        remoteTools,
        client,
        conflictedToolNames: new Set(diagnostics
            .filter((diagnostic) => diagnostic.reason === "duplicate_upstream_tool" && diagnostic.upstreamToolName)
            .map((diagnostic) => diagnostic.upstreamToolName as string)),
    })

    return {
        inventory: resolved.inventory,
        diagnostics: [
            ...diagnostics,
            ...resolved.diagnostics,
        ],
        resolvedTools: resolved.resolvedTools,
    }
}

function resolveRemoteToolBindings(args: {
    provider: HttpMcpProviderConfig
    config: CreateHttpMcpToolBindingsConfig
    requireWhitelist: boolean
    emitDisappearedDiagnostics: boolean
    remoteTools: DiscoveredRemoteTool[]
    client: HttpMcpClient
    conflictedToolNames?: ReadonlySet<string>
}): ResolvedProviderTools {
    const diagnostics: McpToolDiagnostic[] = []
    const inventory: McpToolInventoryEntry[] = []
    const resolvedTools: Array<{ binding: ToolBinding, inventory: McpToolInventoryEntry }> = []
    const approvedTools = buildApprovedToolMap(args.provider)
    const approvedDiscoveryToolNames = buildApprovedDiscoveryToolNames(args.provider, approvedTools)
    const deduplicatedRemoteTools: DiscoveredRemoteTool[] = []
    const deduplicationState = createMcpToolDeduplicationState<DiscoveredRemoteTool>()
    const discoveredToolNames = new Set(args.conflictedToolNames ?? [])

    for (const remoteTool of args.remoteTools) {
        appendDeduplicatedMcpTool({
            provider: args.provider,
            entry: remoteTool,
            entries: deduplicatedRemoteTools,
            state: deduplicationState,
            diagnostics,
        })
    }

    for (const conflictedToolName of deduplicationState.conflictedNames) {
        discoveredToolNames.add(conflictedToolName)
    }

    for (const remoteTool of deduplicatedRemoteTools) {
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
        const discoveredByApprovedToolName = readApprovedDiscoverySource({
            remoteTool,
            approvedDiscoveryToolNames,
        })
        if (!approvedTool && !discoveredByApprovedToolName) {
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

        if (approvedTool?.schemaHash && approvedTool.schemaHash !== candidate.inventory.schemaHash) {
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

        if (approvedTool?.registeredName && approvedTool.registeredName !== candidate.inventory.registeredName) {
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
                client: args.client,
                dynamicRefresh: createDynamicRefreshForTool({
                    provider: args.provider,
                    remoteTool: remoteTool.tool,
                    config: args.config,
                    client: args.client,
                }),
            }),
            inventory: candidate.inventory,
        })
    }

    if (args.requireWhitelist && args.emitDisappearedDiagnostics) {
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

function createDynamicRefreshForTool(args: {
    provider: HttpMcpProviderConfig
    remoteTool: HttpMcpTool
    config: CreateHttpMcpToolBindingsConfig
    client: HttpMcpClient
}): ((result: ToolsCallResult) => Promise<void>) | undefined {
    if (!args.config.dynamicToolRegistry || !isNestedDiscoveryTool(args.provider, args.remoteTool.name)) {
        return undefined
    }

    return async (result) => {
        registerDynamicResolvedTools({
            provider: args.provider,
            config: args.config,
            resolution: resolveDynamicToolsFromDiscoveryResult({
                provider: args.provider,
                config: args.config,
                client: args.client,
                result,
                discoveryToolName: args.remoteTool.name,
            }),
        })

        registerDynamicResolvedTools({
            provider: args.provider,
            config: args.config,
            resolution: await resolveProviderTools({
                provider: args.provider,
                config: {
                    ...args.config,
                    failOnProviderError: false,
                    includeNestedDiscovery: true,
                },
                requireWhitelist: true,
                emitDisappearedDiagnostics: false,
            }),
        })
    }
}

function resolveDynamicToolsFromDiscoveryResult(args: {
    provider: HttpMcpProviderConfig
    config: CreateHttpMcpToolBindingsConfig
    client: HttpMcpClient
    result: ToolsCallResult
    discoveryToolName: string
}): ResolvedProviderTools {
    const diagnostics: McpToolDiagnostic[] = []
    const nested = readNestedDiscoveredTools(args.result)
    appendMcpToolParseIssueDiagnostics({
        providerId: args.provider.id,
        source: "tool_search",
        issues: nested.issues,
        diagnostics,
    })
    const resolved = resolveRemoteToolBindings({
        provider: args.provider,
        config: args.config,
        requireWhitelist: true,
        emitDisappearedDiagnostics: false,
        remoteTools: nested.tools.map((tool) => ({
            tool,
            source: "tool_search" as const,
            discoveredByToolName: args.discoveryToolName,
        })),
        client: args.client,
    })

    return {
        inventory: resolved.inventory,
        diagnostics: [
            ...diagnostics,
            ...resolved.diagnostics,
        ],
        resolvedTools: resolved.resolvedTools,
    }
}

function buildApprovedDiscoveryToolNames(
    provider: HttpMcpProviderConfig,
    approvedTools: ReadonlyMap<string, unknown>
): Set<string> {
    const approvedDiscoveryToolNames = new Set<string>()

    for (const toolName of approvedTools.keys()) {
        if (isNestedDiscoveryTool(provider, toolName)) {
            approvedDiscoveryToolNames.add(toolName)
        }
    }

    return approvedDiscoveryToolNames
}

function readApprovedDiscoverySource(args: {
    remoteTool: DiscoveredRemoteTool
    approvedDiscoveryToolNames: ReadonlySet<string>
}): string | undefined {
    if (args.remoteTool.source !== "tool_search") {
        return undefined
    }
    const discoveryToolName = args.remoteTool.discoveredByToolName
    if (!discoveryToolName || !args.approvedDiscoveryToolNames.has(discoveryToolName)) {
        return undefined
    }

    return discoveryToolName
}

function registerDynamicResolvedTools(args: {
    provider: HttpMcpProviderConfig
    config: CreateHttpMcpToolBindingsConfig
    resolution: ResolvedProviderTools
}): void {
    args.config.dynamicDiagnostics?.push(...args.resolution.diagnostics)
    if (!args.config.dynamicToolRegistry) {
        return
    }

    for (const resolvedTool of args.resolution.resolvedTools) {
        if (args.config.dynamicToolRegistry.has(resolvedTool.binding.name)) {
            continue
        }

        const transformed = args.config.dynamicToolTransform
            ? args.config.dynamicToolTransform(resolvedTool.binding)
            : resolvedTool.binding
        args.config.dynamicToolRegistry.register(transformed)
        args.config.logger?.info("Dynamically registered MCP tool after discovery", {
            providerId: args.provider.id,
            toolName: transformed.name,
        })
    }
}

import type { Logger } from "@valiq-trading/core"
import {
    HttpMcpClient,
    parseMcpToolEntries,
    type HttpMcpTool,
    type HttpMcpToolParseIssue,
    type ToolsCallResult,
} from "./http-client"
import { readMcpSafetyBlock } from "./http-tool-schema"
import { sanitizeMcpError } from "./mcp-error-sanitizer"
import type {
    HttpMcpProviderConfig,
    McpToolDiagnostic,
    McpToolDiscoverySource,
} from "./http-tool-types"

export interface DiscoveredRemoteTool {
    tool: HttpMcpTool
    source: McpToolDiscoverySource
}

export const DEFAULT_MCP_MAX_TOOLS_PER_PROVIDER = 50

const MAX_NESTED_DISCOVERY_CALLS_PER_PROVIDER = 4

export async function discoverProviderRemoteTools(args: {
    provider: HttpMcpProviderConfig
    client: HttpMcpClient
    maxTools: number
    signal?: AbortSignal
    includeNestedDiscovery: boolean
    logger?: Pick<Logger, "debug" | "warn">
    diagnostics: McpToolDiagnostic[]
}): Promise<DiscoveredRemoteTool[]> {
    const discoveredTools: DiscoveredRemoteTool[] = []
    const seenToolNames = new Set<string>()
    const topLevelResult = await args.client.listToolsDetailed({
        signal: args.signal,
        maxTools: args.maxTools,
    })
    const topLevelTools = topLevelResult.tools

    appendParseIssueDiagnostics({
        providerId: args.provider.id,
        source: "tools/list",
        issues: topLevelResult.issues,
        diagnostics: args.diagnostics,
    })
    appendDiscoveredTools({
        providerId: args.provider.id,
        tools: topLevelTools.map((tool) => ({ tool, source: "tools/list" as const })),
        discoveredTools,
        seenToolNames,
        diagnostics: args.diagnostics,
        maxTools: args.maxTools,
    })

    if (!args.includeNestedDiscovery) {
        return discoveredTools
    }

    try {
        const discoveredByMethod = await args.client.discoverToolsDetailed(args.signal)
        appendParseIssueDiagnostics({
            providerId: args.provider.id,
            source: "tools/discover",
            issues: discoveredByMethod.issues,
            diagnostics: args.diagnostics,
        })
        appendDiscoveredTools({
            providerId: args.provider.id,
            tools: discoveredByMethod.tools.map((tool) => ({ tool, source: "tools/discover" as const })),
            discoveredTools,
            seenToolNames,
            diagnostics: args.diagnostics,
            maxTools: args.maxTools,
        })
    } catch (error) {
        args.logger?.debug("Optional MCP tools/discover unavailable", {
            providerId: args.provider.id,
            error: sanitizeMcpError(error),
        })
    }

    await discoverConfiguredNestedTools({
        ...args,
        topLevelTools,
        discoveredTools,
        seenToolNames,
    })

    return discoveredTools
}

function appendDiscoveredTools(args: {
    providerId: string
    tools: DiscoveredRemoteTool[]
    discoveredTools: DiscoveredRemoteTool[]
    seenToolNames: Set<string>
    diagnostics: McpToolDiagnostic[]
    maxTools: number
}): void {
    for (const discoveredTool of args.tools) {
        if (args.seenToolNames.has(discoveredTool.tool.name)) {
            args.diagnostics.push({
                providerId: args.providerId,
                upstreamToolName: discoveredTool.tool.name,
                source: discoveredTool.source,
                reason: "duplicate_upstream_tool",
                message: "MCP tool skipped because the provider discovered the same upstream tool name more than once",
            })
            continue
        }

        if (args.discoveredTools.length >= args.maxTools) {
            args.diagnostics.push({
                providerId: args.providerId,
                upstreamToolName: discoveredTool.tool.name,
                source: discoveredTool.source,
                reason: "discovery_limit_exceeded",
                message: "MCP tool skipped because provider discovery exceeded the configured maxTools limit",
            })
            continue
        }

        args.seenToolNames.add(discoveredTool.tool.name)
        args.discoveredTools.push(discoveredTool)
    }
}

async function discoverConfiguredNestedTools(args: {
    provider: HttpMcpProviderConfig
    client: HttpMcpClient
    maxTools: number
    signal?: AbortSignal
    logger?: Pick<Logger, "warn">
    diagnostics: McpToolDiagnostic[]
    topLevelTools: HttpMcpTool[]
    discoveredTools: DiscoveredRemoteTool[]
    seenToolNames: Set<string>
}): Promise<void> {
    const configuredDiscoveryTools = args.provider.discoveryTools ?? []
    let discoveryCalls = 0

    for (const discoveryConfig of configuredDiscoveryTools) {
        const discoveryTool = args.topLevelTools.find((tool) => tool.name === discoveryConfig.name)
        if (!discoveryTool) {
            args.diagnostics.push({
                providerId: args.provider.id,
                upstreamToolName: discoveryConfig.name,
                source: "tool_search",
                reason: "nested_discovery_failed",
                message: "Nested MCP discovery skipped because the configured discovery tool was not present in tools/list",
            })
            continue
        }

        if (args.provider.blockedTools?.includes(discoveryTool.name)) {
            args.diagnostics.push({
                providerId: args.provider.id,
                upstreamToolName: discoveryTool.name,
                source: "tools/list",
                reason: "provider_blocked",
                message: "Nested MCP discovery skipped because the discovery tool is blocked by provider configuration",
            })
            continue
        }

        const safetyBlock = readMcpSafetyBlock(discoveryTool)
        if (safetyBlock) {
            args.diagnostics.push({
                providerId: args.provider.id,
                upstreamToolName: discoveryTool.name,
                source: "tools/list",
                reason: "unsafe_annotation",
                message: "Nested MCP discovery skipped because the discovery tool safety annotations are unsafe or malformed",
                annotationReason: safetyBlock,
            })
            continue
        }

        for (const discoveryInput of discoveryConfig.inputs) {
            if (discoveryCalls >= MAX_NESTED_DISCOVERY_CALLS_PER_PROVIDER) {
                args.diagnostics.push({
                    providerId: args.provider.id,
                    upstreamToolName: discoveryTool.name,
                    source: "tool_search",
                    reason: "discovery_limit_exceeded",
                    message: "Nested MCP tool discovery stopped because the configured discovery call limit was reached",
                })
                return
            }

            discoveryCalls++
            try {
                const result = await args.client.callTool(discoveryTool.name, discoveryInput, args.signal)
                const nested = readNestedDiscoveredTools(result)
                appendParseIssueDiagnostics({
                    providerId: args.provider.id,
                    source: "tool_search",
                    issues: nested.issues,
                    diagnostics: args.diagnostics,
                })
                appendDiscoveredTools({
                    providerId: args.provider.id,
                    tools: nested.tools.map((tool) => ({
                        tool,
                        source: "tool_search" as const,
                    })),
                    discoveredTools: args.discoveredTools,
                    seenToolNames: args.seenToolNames,
                    diagnostics: args.diagnostics,
                    maxTools: args.maxTools,
                })

                const refreshed = await args.client.listToolsDetailed({
                    signal: args.signal,
                    maxTools: args.maxTools,
                })
                appendParseIssueDiagnostics({
                    providerId: args.provider.id,
                    source: "tool_search",
                    issues: refreshed.issues,
                    diagnostics: args.diagnostics,
                })
                appendDiscoveredTools({
                    providerId: args.provider.id,
                    tools: refreshed.tools.map((tool) => ({ tool, source: "tool_search" as const })),
                    discoveredTools: args.discoveredTools,
                    seenToolNames: args.seenToolNames,
                    diagnostics: args.diagnostics,
                    maxTools: args.maxTools,
                })
            } catch (error) {
                const sanitizedError = sanitizeMcpError(error)
                args.logger?.warn("Nested MCP tool discovery failed", {
                    providerId: args.provider.id,
                    toolName: discoveryTool.name,
                    error: sanitizedError,
                })
                args.diagnostics.push({
                    providerId: args.provider.id,
                    upstreamToolName: discoveryTool.name,
                    source: "tool_search",
                    reason: "nested_discovery_failed",
                    message: sanitizedError,
                })
            }
        }
    }
}

function readNestedDiscoveredTools(result: ToolsCallResult): {
    tools: HttpMcpTool[]
    issues: HttpMcpToolParseIssue[]
} {
    const entries: unknown[] = []

    if (result.structuredContent !== undefined) {
        entries.push(...readMcpToolEntriesFromUnknown(result.structuredContent))
    }

    for (const content of result.content ?? []) {
        if (typeof content.text !== "string") {
            continue
        }

        try {
            entries.push(...readMcpToolEntriesFromUnknown(JSON.parse(content.text) as unknown))
        } catch {
            continue
        }
    }

    return parseMcpToolEntries(entries)
}

function readMcpToolEntriesFromUnknown(value: unknown): unknown[] {
    if (Array.isArray(value)) {
        return value
    }

    if (!value || typeof value !== "object") {
        return []
    }

    const record = value as Record<string, unknown>
    const rawTools = Array.isArray(record.tools)
        ? record.tools
        : Array.isArray(record.results)
            ? record.results
            : Array.isArray(record.items)
                ? record.items
                : []

    return rawTools.map((entry) => {
        if (entry && typeof entry === "object" && !Array.isArray(entry) && "tool" in entry) {
            return (entry as Record<string, unknown>).tool
        }

        return entry
    })
}

function appendParseIssueDiagnostics(args: {
    providerId: string
    source: McpToolDiscoverySource
    issues: HttpMcpToolParseIssue[]
    diagnostics: McpToolDiagnostic[]
}): void {
    for (const issue of args.issues) {
        args.diagnostics.push({
            providerId: args.providerId,
            upstreamToolName: issue.upstreamToolName,
            source: args.source,
            reason: issue.reason,
            message: issue.message,
            schemaReason: issue.schemaReason,
            annotationReason: issue.annotationReason,
        })
    }
}

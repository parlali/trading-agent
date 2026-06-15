import type { HttpMcpTool } from "./http-client"
import {
    buildMcpToolName,
    hashMcpToolSchema,
    sanitizeToolNamePart,
} from "./http-tool-identity"
import { normalizeMcpInputSchema } from "./http-tool-schema"
import type { HttpMcpProviderConfig, McpApprovedTool, McpToolDiagnostic, McpToolDiscoverySource, McpToolInventoryEntry } from "./http-tool-types"

export interface McpToolCandidate {
    inventory: McpToolInventoryEntry
    inputSchema: Record<string, unknown>
}

export function createCandidateForRemoteTool(args: {
    provider: HttpMcpProviderConfig
    remoteTool: HttpMcpTool
    source: McpToolDiscoverySource
}): McpToolCandidate | { diagnostic: McpToolDiagnostic } {
    if (args.provider.blockedTools?.includes(args.remoteTool.name)) {
        return {
            diagnostic: {
                providerId: args.provider.id,
                upstreamToolName: args.remoteTool.name,
                source: args.source,
                reason: "provider_blocked",
                message: "MCP tool skipped because it is blocked by provider configuration",
            },
        }
    }

    const providerPart = sanitizeToolNamePart(args.provider.id)
    const toolPart = sanitizeToolNamePart(args.remoteTool.name)

    if (!providerPart || !toolPart) {
        return {
            diagnostic: {
                providerId: args.provider.id,
                upstreamToolName: args.remoteTool.name,
                source: args.source,
                reason: "invalid_name",
                message: "MCP tool skipped because its provider id or upstream name cannot be converted into a safe registered tool name",
            },
        }
    }

    const inputSchema = normalizeMcpInputSchema(args.remoteTool.inputSchema)
    if (!inputSchema.schema) {
        return {
            diagnostic: {
                providerId: args.provider.id,
                upstreamToolName: args.remoteTool.name,
                source: args.source,
                reason: "schema_incompatible",
                message: "MCP tool skipped because its input schema is not a supported object schema",
                schemaReason: inputSchema.reason,
            },
        }
    }

    const registeredName = buildMcpToolName(providerPart, toolPart, args.provider.id, args.remoteTool.name)
    const description = [
        args.remoteTool.description?.trim() || `Call MCP tool ${args.remoteTool.name}`,
        `Provider: ${args.provider.id}. Upstream tool: ${args.remoteTool.name}.`,
    ].join(" ")

    return {
        inventory: {
            providerId: args.provider.id,
            upstreamToolName: args.remoteTool.name,
            registeredName,
            description,
            source: args.source,
            schemaHash: hashMcpToolSchema(inputSchema.schema),
            inputSchema: inputSchema.schema,
            annotations: args.remoteTool.annotations,
        },
        inputSchema: inputSchema.schema,
    }
}

export function buildApprovedToolMap(provider: HttpMcpProviderConfig): Map<string, McpApprovedTool> {
    if (provider.approvedTools) {
        return new Map(provider.approvedTools.map((tool) => [tool.name, tool]))
    }

    return new Map((provider.allowedTools ?? []).map((name) => [name, { name }]))
}

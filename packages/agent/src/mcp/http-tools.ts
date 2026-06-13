import { z } from "zod"
import type { Logger, VenueApp } from "@valiq-trading/core"
import type { ToolBinding, ToolCategory } from "../tool-registry"
import { HttpMcpClient, type HttpMcpTool } from "./http-client"

export interface HttpMcpProviderConfig {
    id: string
    url: string
    token?: string
    category?: Extract<ToolCategory, "research" | "market-data">
    timeoutMs?: number
    maxTools?: number
    compatibleVenues?: readonly VenueApp[]
}

export interface CreateHttpMcpToolBindingsConfig {
    providers: readonly HttpMcpProviderConfig[]
    logger?: Pick<Logger, "debug" | "info" | "warn" | "error">
    signal?: AbortSignal
}

const remoteMcpParamsSchema = z.record(z.string(), z.unknown())
const DEFAULT_MCP_MAX_TOOLS_PER_PROVIDER = 50

export async function createHttpMcpToolBindings(
    config: CreateHttpMcpToolBindingsConfig
): Promise<ToolBinding[]> {
    const bindings: ToolBinding[] = []
    const registeredNames = new Set<string>()

    for (const provider of config.providers) {
        const client = new HttpMcpClient({
            id: provider.id,
            url: provider.url,
            token: provider.token,
            timeoutMs: provider.timeoutMs,
            logger: config.logger,
        })
        const tools = await client.listTools(config.signal)
        const maxTools = provider.maxTools ?? DEFAULT_MCP_MAX_TOOLS_PER_PROVIDER

        if (tools.length > maxTools) {
            throw new Error(`MCP provider ${provider.id} exposed ${tools.length} tools, exceeding configured maxTools ${maxTools}`)
        }

        for (const remoteTool of tools) {
            const binding = createBindingForRemoteTool({
                provider,
                remoteTool,
                client,
                logger: config.logger,
            })

            if (!binding) {
                continue
            }

            if (registeredNames.has(binding.name)) {
                throw new Error(`Duplicate MCP tool registration detected for ${binding.name}`)
            }

            registeredNames.add(binding.name)
            bindings.push(binding)
        }

        config.logger?.info("MCP provider tools registered", {
            providerId: provider.id,
            registeredTools: bindings.filter((binding) => binding.name.startsWith(`mcp_${sanitizeToolNamePart(provider.id)}_`)).length,
        })
    }

    return bindings
}

function createBindingForRemoteTool(args: {
    provider: HttpMcpProviderConfig
    remoteTool: HttpMcpTool
    client: HttpMcpClient
    logger?: Pick<Logger, "warn">
}): ToolBinding | null {
    const providerPart = sanitizeToolNamePart(args.provider.id)
    const toolPart = sanitizeToolNamePart(args.remoteTool.name)

    if (!providerPart || !toolPart) {
        args.logger?.warn("MCP tool skipped due to invalid name", {
            providerId: args.provider.id,
            toolName: args.remoteTool.name,
        })
        return null
    }

    const inputSchema = normalizeMcpInputSchema(args.remoteTool.inputSchema)
    if (!inputSchema) {
        args.logger?.warn("MCP tool skipped due to unsupported input schema", {
            providerId: args.provider.id,
            toolName: args.remoteTool.name,
        })
        return null
    }

    const registeredName = `mcp_${providerPart}_${toolPart}`
    const description = [
        args.remoteTool.description?.trim() || `Call MCP tool ${args.remoteTool.name}`,
        `Provider: ${args.provider.id}. Upstream tool: ${args.remoteTool.name}.`,
    ].join(" ")

    return {
        name: registeredName,
        description,
        parameters: remoteMcpParamsSchema,
        jsonSchema: inputSchema,
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

function normalizeMcpInputSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> | null {
    if (!schema) {
        return {
            type: "object",
            properties: {},
        }
    }

    if (schema.type && schema.type !== "object") {
        return null
    }

    if (!schema.type) {
        return {
            ...schema,
            type: "object",
        }
    }

    return schema
}

function sanitizeToolNamePart(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 48)
}

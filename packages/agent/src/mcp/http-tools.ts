import { createHash } from "node:crypto"
import { z } from "zod"
import type { Logger, VenueApp } from "@valiq-trading/core"
import type { ToolBinding, ToolCategory } from "../tool-registry"
import { withCallBudget } from "../tools/with-call-budget"
import { HttpMcpClient, type HttpMcpTool } from "./http-client"

export interface HttpMcpProviderConfig {
    id: string
    url: string
    token?: string
    category?: Extract<ToolCategory, "research">
    timeoutMs?: number
    maxTools?: number
    maxListPages?: number
    allowedTools?: readonly string[]
    blockedTools?: readonly string[]
    compatibleVenues?: readonly VenueApp[]
}

export interface CreateHttpMcpToolBindingsConfig {
    providers: readonly HttpMcpProviderConfig[]
    logger?: Pick<Logger, "debug" | "info" | "warn" | "error">
    signal?: AbortSignal
}

const DEFAULT_MCP_MAX_TOOLS_PER_PROVIDER = 50
const MAX_OPENROUTER_TOOL_NAME_LENGTH = 64
const remoteMcpParamsSchema = z.record(z.string(), z.unknown())

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
            maxListPages: provider.maxListPages,
            logger: config.logger,
        })
        const maxTools = provider.maxTools ?? DEFAULT_MCP_MAX_TOOLS_PER_PROVIDER
        const tools = await client.listTools({
            signal: config.signal,
            maxTools,
        })

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

export function withMcpToolCallBudget(tool: ToolBinding, maxCalls: number): ToolBinding {
    return tool.contractOwner?.startsWith("mcp:") === true
        ? withCallBudget(tool, maxCalls)
        : tool
}

function createBindingForRemoteTool(args: {
    provider: HttpMcpProviderConfig
    remoteTool: HttpMcpTool
    client: HttpMcpClient
    logger?: Pick<Logger, "warn">
}): ToolBinding | null {
    if (!isAllowedReadOnlyMcpTool(args.provider, args.remoteTool)) {
        args.logger?.warn("MCP tool skipped because it is not explicitly allowed as read-only", {
            providerId: args.provider.id,
            toolName: args.remoteTool.name,
        })
        return null
    }

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

    const registeredName = buildMcpToolName(providerPart, toolPart, args.provider.id, args.remoteTool.name)
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

function isAllowedReadOnlyMcpTool(
    provider: HttpMcpProviderConfig,
    remoteTool: HttpMcpTool
): boolean {
    if (provider.blockedTools?.includes(remoteTool.name)) {
        return false
    }
    if (!provider.allowedTools?.includes(remoteTool.name)) {
        return false
    }
    if (remoteTool.annotations?.destructiveHint === true || remoteTool.annotations?.openWorldHint === true) {
        return false
    }

    return true
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

    const normalized = schema.type
        ? schema
        : {
            ...schema,
            type: "object",
        }

    return hasValidObjectSchemaFields(normalized)
        ? normalized
        : null
}

function hasValidObjectSchemaFields(schema: Record<string, unknown>): boolean {
    if (schema.properties !== undefined && !isSchemaProperties(schema.properties)) {
        return false
    }

    if (schema.required !== undefined && !isStringArray(schema.required)) {
        return false
    }

    if (schema.additionalProperties !== undefined && !isAdditionalPropertiesSchema(schema.additionalProperties)) {
        return false
    }

    return true
}

function isSchemaProperties(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false
    }

    return Object.values(value as Record<string, unknown>).every((entry) =>
        Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
    )
}

function isStringArray(value: unknown): boolean {
    return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}

function isAdditionalPropertiesSchema(value: unknown): boolean {
    return typeof value === "boolean" ||
        (Boolean(value) && typeof value === "object" && !Array.isArray(value))
}

function sanitizeToolNamePart(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "")
}

function buildMcpToolName(providerPart: string, toolPart: string, rawProviderId: string, rawToolName: string): string {
    const baseName = `mcp_${providerPart}_${toolPart}`
    const sanitizationChanged = providerPart !== rawProviderId || toolPart !== rawToolName
    if (!sanitizationChanged && isValidOpenRouterToolName(baseName)) {
        return baseName
    }

    const hash = createHash("sha256")
        .update(`${rawProviderId}\0${rawToolName}`)
        .digest("hex")
        .slice(0, 10)
    const prefix = "mcp_"
    const separatorLength = 2
    const available = MAX_OPENROUTER_TOOL_NAME_LENGTH - prefix.length - separatorLength - hash.length
    const providerLength = Math.max(8, Math.floor(available * 0.4))
    const toolLength = Math.max(8, available - providerLength)
    const shortened = `${prefix}${providerPart.slice(0, providerLength)}_${toolPart.slice(0, toolLength)}_${hash}`

    if (!isValidOpenRouterToolName(shortened)) {
        throw new Error(`MCP tool name could not be made OpenRouter-compatible for provider ${rawProviderId} tool ${rawToolName}`)
    }

    return shortened
}

function isValidOpenRouterToolName(value: string): boolean {
    return value.length > 0 &&
        value.length <= MAX_OPENROUTER_TOOL_NAME_LENGTH &&
        /^[a-zA-Z0-9_-]+$/.test(value)
}

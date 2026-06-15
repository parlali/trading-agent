import { createHash } from "node:crypto"
import { z } from "zod"
import type { Logger, VenueApp } from "@valiq-trading/core"
import type { ToolBinding, ToolCategory } from "../tool-registry"
import { withCallBudget } from "../tools/with-call-budget"
import { HttpMcpClient, type HttpMcpTool, type ToolsCallResult } from "./http-client"

export interface McpApprovedTool {
    name: string
    registeredName?: string
    schemaHash?: string
}

export interface McpToolApproval {
    providerId: string
    toolName: string
    registeredName: string
    schemaHash: string
}

export interface HttpMcpProviderConfig {
    id: string
    url: string
    token?: string
    category?: Extract<ToolCategory, "research">
    timeoutMs?: number
    maxTools?: number
    maxListPages?: number
    allowedTools?: readonly string[]
    approvedTools?: readonly McpApprovedTool[]
    blockedTools?: readonly string[]
    compatibleVenues?: readonly VenueApp[]
}

export type McpToolDiscoverySource = "tools/list" | "tools/discover" | "tool_search"

export type McpToolSkipReason =
    | "provider_unavailable"
    | "provider_blocked"
    | "strategy_whitelist_missing"
    | "strategy_whitelist_empty"
    | "provider_not_configured"
    | "not_whitelisted"
    | "tool_disappeared"
    | "schema_changed"
    | "registered_name_changed"
    | "schema_incompatible"
    | "unsafe_annotation"
    | "invalid_name"
    | "duplicate_upstream_tool"
    | "duplicate_registered_name"
    | "discovery_tool"
    | "nested_discovery_failed"
    | "nested_discovery_unsupported_schema"
    | "discovery_limit_exceeded"

export interface McpToolDiagnostic {
    providerId: string
    upstreamToolName?: string
    registeredName?: string
    source?: McpToolDiscoverySource
    reason: McpToolSkipReason
    message: string
    schemaReason?: string
    annotationReason?: string
}

export interface McpToolInventoryEntry {
    providerId: string
    upstreamToolName: string
    registeredName: string
    description: string
    source: McpToolDiscoverySource
    schemaHash: string
}

export interface CreateHttpMcpToolBindingsConfig {
    providers: readonly HttpMcpProviderConfig[]
    logger?: Pick<Logger, "debug" | "info" | "warn" | "error">
    signal?: AbortSignal
    failOnProviderError?: boolean
    includeNestedDiscovery?: boolean
}

export interface HttpMcpToolBindingResolution {
    bindings: ToolBinding[]
    inventory: McpToolInventoryEntry[]
    diagnostics: McpToolDiagnostic[]
}

interface DiscoveredRemoteTool {
    tool: HttpMcpTool
    source: McpToolDiscoverySource
}

interface McpToolCandidate {
    inventory: McpToolInventoryEntry
    inputSchema: Record<string, unknown>
}

const DEFAULT_MCP_MAX_TOOLS_PER_PROVIDER = 50
const MAX_OPENROUTER_TOOL_NAME_LENGTH = 64
const MAX_NESTED_DISCOVERY_CALLS_PER_PROVIDER = 4
const NESTED_DISCOVERY_TOOL_NAMES = new Set(["tool_search", "tools_discover", "discover_tools"])
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

async function discoverProviderRemoteTools(args: {
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
    const topLevelTools = await args.client.listTools({
        signal: args.signal,
        maxTools: args.maxTools,
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
        const discoveredByMethod = await args.client.discoverTools(args.signal)
        appendDiscoveredTools({
            providerId: args.provider.id,
            tools: discoveredByMethod.map((tool) => ({ tool, source: "tools/discover" as const })),
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

    const nestedDiscoveryTools = topLevelTools.filter((tool) =>
        NESTED_DISCOVERY_TOOL_NAMES.has(tool.name)
    )
    let discoveryCalls = 0

    for (const discoveryTool of nestedDiscoveryTools) {
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

        const discoveryInputs = buildNestedDiscoveryInputs(discoveryTool)
        if ("diagnostic" in discoveryInputs) {
            args.diagnostics.push({
                ...discoveryInputs.diagnostic,
                providerId: args.provider.id,
                upstreamToolName: discoveryTool.name,
                source: "tools/list",
            })
            continue
        }

        for (const discoveryInput of discoveryInputs.inputs) {
            if (discoveryCalls >= MAX_NESTED_DISCOVERY_CALLS_PER_PROVIDER) {
                args.diagnostics.push({
                    providerId: args.provider.id,
                    upstreamToolName: discoveryTool.name,
                    source: "tool_search",
                    reason: "discovery_limit_exceeded",
                    message: "Nested MCP tool discovery stopped because the configured discovery call limit was reached",
                })
                return discoveredTools
            }

            discoveryCalls++
            try {
                const result = await args.client.callTool(discoveryTool.name, discoveryInput, args.signal)
                appendDiscoveredTools({
                    providerId: args.provider.id,
                    tools: readNestedDiscoveredTools(args.provider.id, result).map((tool) => ({
                        tool,
                        source: "tool_search" as const,
                    })),
                    discoveredTools,
                    seenToolNames,
                    diagnostics: args.diagnostics,
                    maxTools: args.maxTools,
                })

                const refreshedTools = await args.client.listTools({
                    signal: args.signal,
                    maxTools: args.maxTools,
                })
                appendDiscoveredTools({
                    providerId: args.provider.id,
                    tools: refreshedTools.map((tool) => ({ tool, source: "tool_search" as const })),
                    discoveredTools,
                    seenToolNames,
                    diagnostics: args.diagnostics,
                    maxTools: args.maxTools,
                })
            } catch (error) {
                args.logger?.warn("Nested MCP tool discovery failed", {
                    providerId: args.provider.id,
                    toolName: discoveryTool.name,
                    error: sanitizeMcpError(error),
                })
                args.diagnostics.push({
                    providerId: args.provider.id,
                    upstreamToolName: discoveryTool.name,
                    source: "tool_search",
                    reason: "nested_discovery_failed",
                    message: sanitizeMcpError(error),
                })
            }
        }
    }

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

function createCandidateForRemoteTool(args: {
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

    if (NESTED_DISCOVERY_TOOL_NAMES.has(args.remoteTool.name)) {
        return {
            diagnostic: {
                providerId: args.provider.id,
                upstreamToolName: args.remoteTool.name,
                source: args.source,
                reason: "discovery_tool",
                message: "MCP discovery meta-tool skipped so strategy runs cannot bypass the persisted whitelist",
            },
        }
    }

    const safetyBlock = readMcpSafetyBlock(args.remoteTool)
    if (safetyBlock) {
        return {
            diagnostic: {
                providerId: args.provider.id,
                upstreamToolName: args.remoteTool.name,
                source: args.source,
                reason: "unsafe_annotation",
                message: "MCP tool skipped because its safety annotations are unsafe or malformed",
                annotationReason: safetyBlock,
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
        },
        inputSchema: inputSchema.schema,
    }
}

function buildApprovedToolMap(provider: HttpMcpProviderConfig): Map<string, McpApprovedTool> {
    if (provider.approvedTools) {
        return new Map(provider.approvedTools.map((tool) => [tool.name, tool]))
    }

    return new Map((provider.allowedTools ?? []).map((name) => [name, { name }]))
}

function readMcpSafetyBlock(remoteTool: HttpMcpTool): string | undefined {
    const destructiveHint = remoteTool.annotations?.destructiveHint as unknown
    const openWorldHint = remoteTool.annotations?.openWorldHint as unknown

    return readBlockingMcpSafetyHint("destructiveHint", destructiveHint) ??
        readBlockingMcpSafetyHint("openWorldHint", openWorldHint)
}

function readBlockingMcpSafetyHint(name: string, value: unknown): string | undefined {
    if (value === undefined || value === false) {
        return undefined
    }

    if (value === true) {
        return `${name} is true`
    }

    return `${name} is malformed`
}

function normalizeMcpInputSchema(schema: Record<string, unknown> | undefined): { schema: Record<string, unknown> | null, reason?: string } {
    if (!schema) {
        return {
            schema: {
                type: "object",
                properties: {},
            },
        }
    }

    if (schema.type && schema.type !== "object") {
        return {
            schema: null,
            reason: "schema type must be object",
        }
    }

    const normalized = schema.type
        ? schema
        : {
            ...schema,
            type: "object",
        }

    const invalidFieldReason = readInvalidObjectSchemaFieldReason(normalized)

    return invalidFieldReason
        ? { schema: null, reason: invalidFieldReason }
        : { schema: normalized }
}

function readInvalidObjectSchemaFieldReason(schema: Record<string, unknown>): string | undefined {
    if (schema.properties !== undefined && !isSchemaProperties(schema.properties)) {
        return "properties must be an object with object-valued fields"
    }

    if (schema.required !== undefined && !isStringArray(schema.required)) {
        return "required must be a string array"
    }

    if (schema.additionalProperties !== undefined && !isAdditionalPropertiesSchema(schema.additionalProperties)) {
        return "additionalProperties must be boolean or an object schema"
    }

    return undefined
}

function isSchemaProperties(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false
    }

    return Object.values(value as Record<string, unknown>).every((entry) =>
        Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
    )
}

function isStringArray(value: unknown): value is string[] {
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

export function hashMcpToolSchema(schema: Record<string, unknown>): string {
    return createHash("sha256")
        .update(stableJsonStringify(schema))
        .digest("hex")
}

function stableJsonStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map((entry) => stableJsonStringify(entry)).join(",")}]`
    }

    if (value && typeof value === "object") {
        return `{${Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonStringify(entry)}`)
            .join(",")}}`
    }

    return JSON.stringify(value)
}

function buildNestedDiscoveryInputs(remoteTool: HttpMcpTool): { inputs: Record<string, unknown>[] } | { diagnostic: Omit<McpToolDiagnostic, "providerId"> } {
    const schema = remoteTool.inputSchema
    const properties = schema?.properties
    const required = schema?.required
    const requiredFields = isStringArray(required) ? required : []

    if (required !== undefined && !isStringArray(required)) {
        return {
            diagnostic: {
                reason: "nested_discovery_unsupported_schema",
                message: "Nested MCP discovery skipped because the discovery tool has malformed required fields",
                schemaReason: "required must be a string array",
            },
        }
    }

    if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
        if (requiredFields.length > 0) {
            return {
                diagnostic: {
                    reason: "nested_discovery_unsupported_schema",
                    message: "Nested MCP discovery skipped because the discovery tool has required fields without object properties",
                    schemaReason: `required fields: ${requiredFields.join(", ")}`,
                },
            }
        }

        return { inputs: [{}] }
    }

    const propertyNames = new Set(Object.keys(properties))
    const supportedRequiredFields = new Set(["query", "limit", "maxResults", "max_tools"])
    if (requiredFields.some((field) => !supportedRequiredFields.has(field))) {
        return {
            diagnostic: {
                reason: "nested_discovery_unsupported_schema",
                message: "Nested MCP discovery skipped because the discovery tool requires unsupported inputs",
                schemaReason: `unsupported required fields: ${requiredFields.filter((field) => !supportedRequiredFields.has(field)).join(", ")}`,
            },
        }
    }

    const withLimit = (query?: string) => {
        const input: Record<string, unknown> = {}
        if (propertyNames.has("query")) {
            input.query = query ?? ""
        }
        if (propertyNames.has("limit")) {
            input.limit = DEFAULT_MCP_MAX_TOOLS_PER_PROVIDER
        }
        if (propertyNames.has("maxResults")) {
            input.maxResults = DEFAULT_MCP_MAX_TOOLS_PER_PROVIDER
        }
        if (propertyNames.has("max_tools")) {
            input.max_tools = DEFAULT_MCP_MAX_TOOLS_PER_PROVIDER
        }
        return input
    }

    if (propertyNames.has("query") || requiredFields.includes("query")) {
        return {
            inputs: [
                withLimit(""),
                withLimit("all"),
            ],
        }
    }

    return { inputs: [withLimit()] }
}

function readNestedDiscoveredTools(providerId: string, result: ToolsCallResult): HttpMcpTool[] {
    const tools: HttpMcpTool[] = []

    if (result.structuredContent !== undefined) {
        tools.push(...readMcpToolsFromUnknown(providerId, result.structuredContent))
    }

    for (const content of result.content ?? []) {
        if (typeof content.text !== "string") {
            continue
        }

        try {
            tools.push(...readMcpToolsFromUnknown(providerId, JSON.parse(content.text) as unknown))
        } catch {
            continue
        }
    }

    return tools
}

function readMcpToolsFromUnknown(providerId: string, value: unknown): HttpMcpTool[] {
    if (Array.isArray(value)) {
        return value.map((entry, index) => readMcpToolFromUnknown(providerId, entry, index)).filter(isNonNullable)
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

    return rawTools.map((entry, index) => {
        if (entry && typeof entry === "object" && !Array.isArray(entry) && "tool" in entry) {
            return readMcpToolFromUnknown(providerId, (entry as Record<string, unknown>).tool, index)
        }

        return readMcpToolFromUnknown(providerId, entry, index)
    }).filter(isNonNullable)
}

function readMcpToolFromUnknown(providerId: string, value: unknown, index: number): HttpMcpTool | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined
    }

    const record = value as Record<string, unknown>
    const inputSchema = record.inputSchema ?? record.input_schema
    if (typeof record.name !== "string" || record.name.trim().length === 0) {
        return undefined
    }

    if (record.description !== undefined && typeof record.description !== "string") {
        return undefined
    }

    if (inputSchema !== undefined && (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema))) {
        return undefined
    }

    if (record.annotations !== undefined && (!record.annotations || typeof record.annotations !== "object" || Array.isArray(record.annotations))) {
        return undefined
    }

    return {
        name: record.name.trim(),
        description: record.description,
        inputSchema: inputSchema as Record<string, unknown> | undefined,
        annotations: record.annotations as HttpMcpTool["annotations"],
    }
}

function sanitizeMcpError(error: unknown): string {
    if (error instanceof Error) {
        return error.message
    }

    return "MCP provider request failed"
}

function isNonNullable<T>(value: T): value is NonNullable<T> {
    return value !== null && value !== undefined
}

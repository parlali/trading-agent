import type { HttpMcpTool } from "./http-client"
import {
    buildMcpToolName,
    hashMcpToolSchema,
    sanitizeToolNamePart,
} from "./http-tool-identity"
import { normalizeMcpInputSchema } from "./http-tool-schema"
import type {
    HttpMcpProviderConfig,
    McpToolAnnotations,
    McpToolDiagnostic,
    McpToolDiscoverySource,
} from "./http-tool-types"
import { stableJsonKey } from "./stable-json"

export interface McpToolDeduplicationEntry {
    tool: HttpMcpTool
    source: McpToolDiscoverySource
}

export interface McpToolDuplicateIdentity {
    upstreamToolName: string
    registeredName?: string
    source: McpToolDiscoverySource
    schemaHash?: string
    schemaKey: string
    schemaSummary: string
    annotationKey: string
    annotationSummary: string
}

export interface McpToolDuplicateConflict {
    fields: string[]
    schemaReason?: string
    annotationReason?: string
}

export interface McpToolDeduplicationState<T extends McpToolDeduplicationEntry> {
    acceptedByName: Map<string, { entry: T, identity: McpToolDuplicateIdentity }>
    conflictedNames: Set<string>
}

export function createMcpToolDeduplicationState<T extends McpToolDeduplicationEntry>(): McpToolDeduplicationState<T> {
    return {
        acceptedByName: new Map(),
        conflictedNames: new Set(),
    }
}

export function appendDeduplicatedMcpTool<T extends McpToolDeduplicationEntry>(args: {
    provider: HttpMcpProviderConfig
    entry: T
    entries: T[]
    state: McpToolDeduplicationState<T>
    diagnostics: McpToolDiagnostic[]
    maxTools?: number
}): void {
    const upstreamToolName = args.entry.tool.name
    if (args.state.conflictedNames.has(upstreamToolName)) {
        return
    }

    const identity = createMcpToolDuplicateIdentity({
        provider: args.provider,
        tool: args.entry.tool,
        source: args.entry.source,
    })
    const existing = args.state.acceptedByName.get(upstreamToolName)

    if (existing) {
        const conflict = readMcpToolDuplicateConflict(existing.identity, identity)
        if (!conflict) {
            return
        }

        removeAcceptedEntry(args.entries, upstreamToolName)
        args.state.acceptedByName.delete(upstreamToolName)
        args.state.conflictedNames.add(upstreamToolName)
        args.diagnostics.push({
            providerId: args.provider.id,
            upstreamToolName,
            registeredName: identity.registeredName ?? existing.identity.registeredName,
            source: args.entry.source,
            reason: "duplicate_upstream_tool",
            message: `MCP tool skipped because repeated upstream tool name conflicts with the ${existing.entry.source} definition (${conflict.fields.join(", ")})`,
            schemaReason: conflict.schemaReason,
            annotationReason: conflict.annotationReason,
        })
        return
    }

    if (args.maxTools !== undefined && args.entries.length >= args.maxTools) {
        args.diagnostics.push({
            providerId: args.provider.id,
            upstreamToolName,
            source: args.entry.source,
            reason: "discovery_limit_exceeded",
            message: "MCP tool skipped because provider discovery exceeded the configured maxTools limit",
        })
        return
    }

    args.state.acceptedByName.set(upstreamToolName, {
        entry: args.entry,
        identity,
    })
    args.entries.push(args.entry)
}

export function createMcpToolDuplicateIdentity(args: {
    provider: HttpMcpProviderConfig
    tool: HttpMcpTool
    source: McpToolDiscoverySource
}): McpToolDuplicateIdentity {
    const providerPart = sanitizeToolNamePart(args.provider.id)
    const toolPart = sanitizeToolNamePart(args.tool.name)
    const registeredName = providerPart && toolPart
        ? buildMcpToolName(providerPart, toolPart, args.provider.id, args.tool.name)
        : undefined
    const inputSchema = normalizeMcpInputSchema(args.tool.inputSchema)
    const schemaHash = inputSchema.schema
        ? hashMcpToolSchema(inputSchema.schema)
        : undefined
    const schemaKey = schemaHash
        ? `valid:${schemaHash}`
        : `invalid:${inputSchema.reason ?? "unknown"}:${stableJsonKey(args.tool.inputSchema ?? null)}`

    return {
        upstreamToolName: args.tool.name,
        registeredName,
        source: args.source,
        schemaHash,
        schemaKey,
        schemaSummary: schemaHash ?? `invalid ${inputSchema.reason ?? "unknown"}`,
        annotationKey: stableJsonKey(args.tool.annotations ?? null),
        annotationSummary: formatAnnotationSummary(args.tool.annotations),
    }
}

export function readMcpToolDuplicateConflict(
    first: McpToolDuplicateIdentity,
    repeated: McpToolDuplicateIdentity
): McpToolDuplicateConflict | undefined {
    const fields: string[] = []
    let schemaReason: string | undefined
    let annotationReason: string | undefined

    if (first.registeredName !== repeated.registeredName) {
        fields.push("registered name")
    }

    if (first.schemaKey !== repeated.schemaKey) {
        fields.push("schema")
        schemaReason = `first ${first.source} schema ${first.schemaSummary}; repeated ${repeated.source} schema ${repeated.schemaSummary}`
    }

    if (first.annotationKey !== repeated.annotationKey) {
        fields.push("annotations")
        annotationReason = `first ${first.source} annotations ${first.annotationSummary}; repeated ${repeated.source} annotations ${repeated.annotationSummary}`
    }

    return fields.length > 0
        ? {
            fields,
            schemaReason,
            annotationReason,
        }
        : undefined
}

function removeAcceptedEntry<T extends McpToolDeduplicationEntry>(entries: T[], upstreamToolName: string): void {
    const index = entries.findIndex((entry) => entry.tool.name === upstreamToolName)
    if (index >= 0) {
        entries.splice(index, 1)
    }
}

function formatAnnotationSummary(annotations: McpToolAnnotations | undefined): string {
    return annotations
        ? stableJsonKey(annotations)
        : "none"
}

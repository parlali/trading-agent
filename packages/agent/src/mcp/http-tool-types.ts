import type { Logger, VenueApp } from "@valiq-trading/core"
import type { ToolBinding, ToolCategory, ToolRegistry } from "../tool-registry"

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
    description?: string
    source?: McpToolDiscoverySource
    inputSchema?: Record<string, unknown>
    approvedAt?: number
    approvedBy?: string
    approvalReason?: string
}

export interface McpNestedDiscoveryToolConfig {
    name: string
    inputs: readonly Record<string, unknown>[]
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
    discoveryTools?: readonly McpNestedDiscoveryToolConfig[]
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
    | "malformed_tool"
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
    inputSchema: Record<string, unknown>
}

export interface CreateHttpMcpToolBindingsConfig {
    providers: readonly HttpMcpProviderConfig[]
    logger?: Pick<Logger, "debug" | "info" | "warn" | "error">
    signal?: AbortSignal
    failOnProviderError?: boolean
    includeNestedDiscovery?: boolean
    dynamicToolRegistry?: ToolRegistry
    dynamicToolTransform?: (tool: ToolBinding) => ToolBinding
    dynamicDiagnostics?: McpToolDiagnostic[]
}

export interface HttpMcpToolBindingResolution {
    bindings: ToolBinding[]
    inventory: McpToolInventoryEntry[]
    diagnostics: McpToolDiagnostic[]
}

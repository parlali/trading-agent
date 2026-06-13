import type { Logger, VenueApp } from "@valiq-trading/core"
import type { HttpMcpProviderConfig } from "./http-tools"

export const MCP_PROVIDER_SECRET_KEYS = [
    "MCP_PROVIDER_CONFIGS",
    "MCP_SERVER_URL",
    "MCP_SERVER_TOKEN",
] as const

export interface ResolveMcpProviderConfigsInput {
    secrets: Record<string, string | null | undefined>
    logger?: Pick<Logger, "warn">
    compatibleVenues?: readonly VenueApp[]
}

export function resolveMcpProviderConfigs(
    input: ResolveMcpProviderConfigsInput
): HttpMcpProviderConfig[] {
    return dedupeMcpProviders([
        ...resolveJsonMcpProviders(input),
        ...resolveSingleMcpProvider(input),
    ])
}

function resolveJsonMcpProviders(input: ResolveMcpProviderConfigsInput): HttpMcpProviderConfig[] {
    const raw = input.secrets.MCP_PROVIDER_CONFIGS
    if (!raw) {
        return []
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch (error) {
        throw new Error(`MCP_PROVIDER_CONFIGS is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }

    if (!Array.isArray(parsed)) {
        throw new Error("MCP_PROVIDER_CONFIGS must be a JSON array")
    }

    return parsed.map((entry, index) =>
        normalizeMcpProviderConfig(entry, `MCP_PROVIDER_CONFIGS[${index}]`, input.compatibleVenues)
    )
}

function resolveSingleMcpProvider(input: ResolveMcpProviderConfigsInput): HttpMcpProviderConfig[] {
    const url = input.secrets.MCP_SERVER_URL
    const token = input.secrets.MCP_SERVER_TOKEN ?? undefined
    if (!url) {
        if (token) {
            input.logger?.warn("MCP server token ignored because MCP_SERVER_URL is not configured")
        }
        return []
    }

    return [{
        id: "default",
        url,
        token,
        category: "research",
        compatibleVenues: input.compatibleVenues,
    }]
}

function normalizeMcpProviderConfig(
    value: unknown,
    source: string,
    compatibleVenues: readonly VenueApp[] | undefined
): HttpMcpProviderConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${source} must be an object`)
    }

    const record = value as Record<string, unknown>
    const category = readOptionalCategory(record.category, `${source}.category`)

    return {
        id: readRequiredString(record.id, `${source}.id`),
        url: readRequiredString(record.url, `${source}.url`),
        token: readOptionalString(record.token),
        category: category ?? "research",
        timeoutMs: readOptionalPositiveInteger(record.timeoutMs, `${source}.timeoutMs`),
        maxTools: readOptionalPositiveInteger(record.maxTools, `${source}.maxTools`),
        maxListPages: readOptionalPositiveInteger(record.maxListPages, `${source}.maxListPages`),
        compatibleVenues,
    }
}

function dedupeMcpProviders(providers: HttpMcpProviderConfig[]): HttpMcpProviderConfig[] {
    const seen = new Set<string>()
    const deduped: HttpMcpProviderConfig[] = []

    for (const provider of providers) {
        if (seen.has(provider.id)) {
            throw new Error(`Duplicate MCP provider id configured: ${provider.id}`)
        }

        seen.add(provider.id)
        deduped.push(provider)
    }

    return deduped
}

function readRequiredString(value: unknown, label: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`${label} must be a non-empty string`)
    }

    return value.trim()
}

function readOptionalString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : undefined
}

function readOptionalCategory(value: unknown, label: string): HttpMcpProviderConfig["category"] | undefined {
    if (value === undefined || value === null || value === "") {
        return undefined
    }

    if (value === "research") {
        return value
    }

    throw new Error(`${label} must be research`)
}

function readOptionalPositiveInteger(value: unknown, label: string): number | undefined {
    if (value === undefined || value === null || value === "") {
        return undefined
    }

    const parsed = typeof value === "number" ? value : Number(value)
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${label} must be a positive integer`)
    }

    return parsed
}

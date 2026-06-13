import {
    createHttpMcpToolBindings,
    type HttpMcpProviderConfig,
} from "@valiq-trading/agent"
import {
    VENUE_APPS,
    isWithinSessionFlatWindow,
    type App,
} from "@valiq-trading/core"
import type { ExtraToolsConfig, PreRunHookConfig } from "../types"

const NUMBERED_MCP_PROVIDER_COUNT = 5

export const MCP_STANDARD_TOOL_SECRET_KEYS = [
    "MCP_PROVIDER_CONFIGS",
    "MCP_SERVER_URL",
    "MCP_SERVER_TOKEN",
    ...Array.from({ length: NUMBERED_MCP_PROVIDER_COUNT }, (_, index) => [
        `MCP_PROVIDER_${index + 1}_ID`,
        `MCP_PROVIDER_${index + 1}_URL`,
        `MCP_PROVIDER_${index + 1}_TOKEN`,
        `MCP_PROVIDER_${index + 1}_CATEGORY`,
        `MCP_PROVIDER_${index + 1}_TIMEOUT_MS`,
        `MCP_PROVIDER_${index + 1}_MAX_TOOLS`,
    ]).flat(),
] as const

export function appendMcpSecretKeys(keys: readonly string[]): string[] {
    return Array.from(new Set([
        ...keys,
        ...MCP_STANDARD_TOOL_SECRET_KEYS,
    ]))
}

export async function createMcpTools(config: ExtraToolsConfig) {
    const providers = resolveMcpProviderConfigs(config)
    if (providers.length === 0) {
        return []
    }

    return await createHttpMcpToolBindings({
        providers,
        logger: config.runLogger,
    })
}

interface SessionFlatPolicy {
    tradingHours: {
        end: string
        timezone: string
    }
    safety: {
        sessionFlat: {
            enabled: boolean
            closeBufferMinutes: number
            timezone?: string
        }
    }
}

interface ExecuteSessionFlatIfNeededArgs {
    app: App
    strategyId: string
    policy: SessionFlatPolicy
    config: Pick<PreRunHookConfig, "logger" | "createAlert" | "ownedPositions" | "ownedWorkingOrders" | "sessionFlat">
    unavailableMessage: string
    triggeredLogMessage: string
    completedLogMessage: string
}

export async function executeSessionFlatIfNeeded(
    args: ExecuteSessionFlatIfNeededArgs
): Promise<boolean> {
    const sessionFlatPolicy = args.policy.safety.sessionFlat
    if (!sessionFlatPolicy.enabled) {
        return false
    }

    const timezone = sessionFlatPolicy.timezone || args.policy.tradingHours.timezone
    const flattenWindow = isWithinSessionFlatWindow({
        end: args.policy.tradingHours.end,
        timezone,
        closeBufferMinutes: sessionFlatPolicy.closeBufferMinutes,
    })

    if (!flattenWindow.shouldFlatten) {
        return false
    }

    const positions = args.config.ownedPositions
    const workingOrders = args.config.ownedWorkingOrders
    if (positions.length === 0 && workingOrders.length === 0) {
        return false
    }

    args.config.logger.warn(args.triggeredLogMessage, {
        strategyId: args.strategyId,
        currentTime: flattenWindow.currentTime,
        endTime: args.policy.tradingHours.end,
        closeBufferMinutes: sessionFlatPolicy.closeBufferMinutes,
        openPositions: positions.length,
        workingOrders: workingOrders.length,
    })

    await args.config.createAlert({
        strategyId: args.strategyId,
        app: args.app,
        severity: "warning",
        message: `Session-flat policy triggered: closing ${positions.length} position(s) and cancelling ${workingOrders.length} working order(s) before ${args.policy.tradingHours.end} ${timezone}`,
    })

    if (!args.config.sessionFlat) {
        throw new Error(args.unavailableMessage)
    }

    const result = await args.config.sessionFlat.execute({
        positions,
        workingOrders,
        reason: `Session-flat before ${args.policy.tradingHours.end} ${timezone}`,
    })
    args.config.logger.info(args.completedLogMessage, {
        strategyId: args.strategyId,
        closed: result.closed,
        cancelled: result.cancelled,
    })

    return true
}

function resolveMcpProviderConfigs(config: ExtraToolsConfig): HttpMcpProviderConfig[] {
    return dedupeMcpProviders([
        ...resolveJsonMcpProviders(config),
        ...resolveSingleMcpProvider(config),
        ...resolveNumberedMcpProviders(config),
    ])
}

function resolveJsonMcpProviders(config: ExtraToolsConfig): HttpMcpProviderConfig[] {
    const raw = config.secrets.MCP_PROVIDER_CONFIGS
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
        normalizeMcpProviderConfig(entry, `MCP_PROVIDER_CONFIGS[${index}]`)
    )
}

function resolveSingleMcpProvider(config: ExtraToolsConfig): HttpMcpProviderConfig[] {
    const url = config.secrets.MCP_SERVER_URL
    const token = config.secrets.MCP_SERVER_TOKEN ?? undefined
    if (!url) {
        if (token) {
            config.runLogger.warn("MCP server token ignored because MCP_SERVER_URL is not configured")
        }
        return []
    }

    return [{
        id: "default",
        url,
        token,
        category: "research",
        compatibleVenues: VENUE_APPS,
    }]
}

function resolveNumberedMcpProviders(config: ExtraToolsConfig): HttpMcpProviderConfig[] {
    const providers: HttpMcpProviderConfig[] = []

    for (let index = 1; index <= NUMBERED_MCP_PROVIDER_COUNT; index++) {
        const id = config.secrets[`MCP_PROVIDER_${index}_ID`]
        const url = config.secrets[`MCP_PROVIDER_${index}_URL`]
        const token = config.secrets[`MCP_PROVIDER_${index}_TOKEN`] ?? undefined
        const category = config.secrets[`MCP_PROVIDER_${index}_CATEGORY`]
        const timeoutMs = config.secrets[`MCP_PROVIDER_${index}_TIMEOUT_MS`]
        const maxTools = config.secrets[`MCP_PROVIDER_${index}_MAX_TOOLS`]

        if (!url) {
            const configured = [id, token, category, timeoutMs, maxTools].some(Boolean)
            if (configured) {
                config.runLogger.warn("MCP provider ignored because URL is missing", {
                    providerIndex: index,
                })
            }
            continue
        }

        providers.push(normalizeMcpProviderConfig({
            id: id || `provider_${index}`,
            url,
            token,
            category,
            timeoutMs,
            maxTools,
        }, `MCP_PROVIDER_${index}`))
    }

    return providers
}

function normalizeMcpProviderConfig(value: unknown, source: string): HttpMcpProviderConfig {
    if (!value || typeof value !== "object") {
        throw new Error(`${source} must be an object`)
    }

    const record = value as Record<string, unknown>
    const id = readRequiredString(record.id, `${source}.id`)
    const url = readRequiredString(record.url, `${source}.url`)
    const category = readOptionalCategory(record.category, `${source}.category`)
    const timeoutMs = readOptionalPositiveInteger(record.timeoutMs, `${source}.timeoutMs`)
    const maxTools = readOptionalPositiveInteger(record.maxTools, `${source}.maxTools`)

    return {
        id,
        url,
        token: readOptionalString(record.token),
        category: category ?? "research",
        timeoutMs,
        maxTools,
        compatibleVenues: VENUE_APPS,
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

    if (value === "research" || value === "market-data") {
        return value
    }

    throw new Error(`${label} must be research or market-data`)
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

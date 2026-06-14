import {
    MCP_PROVIDER_SECRET_KEYS,
    createHttpMcpToolBindings,
    resolveMcpProviderConfigs as resolveCanonicalMcpProviderConfigs,
} from "@valiq-trading/agent"
import {
    VENUE_APPS,
    isWithinSessionFlatWindow,
    type App,
} from "@valiq-trading/core"
import type { ExtraToolsConfig, PreRunHookConfig } from "../types"

export const MCP_STANDARD_TOOL_SECRET_KEYS = [
    ...MCP_PROVIDER_SECRET_KEYS,
] as const

export function appendMcpSecretKeys(keys: readonly string[]): string[] {
    return Array.from(new Set([
        ...keys,
        ...MCP_STANDARD_TOOL_SECRET_KEYS,
    ]))
}

export async function createMcpTools(config: ExtraToolsConfig) {
    const providers = resolvePluginMcpProviderConfigs(config)
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

function resolvePluginMcpProviderConfigs(config: ExtraToolsConfig) {
    return resolveCanonicalMcpProviderConfigs({
        secrets: config.secrets,
        logger: config.runLogger,
        compatibleVenues: VENUE_APPS,
    })
}

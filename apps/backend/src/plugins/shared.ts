import type { ToolDefinition } from "@valiq-trading/agent"
import {
    createOAuthTokenProvider,
    createValiqBreakingNewsTool,
    createValiqDataTool,
    createValiqResearchTool,
    getMissingValiqDataApiSecrets,
    resolveValiqDataApiConfig,
    VALIQ_DATA_SECRET_KEYS,
    ValiqClient,
    ValiqDataAdapter,
    ValiqDataClient,
    ValiqResearchAdapter,
} from "@valiq-trading/valiq"
import {
    isWithinSessionFlatWindow,
    type App,
} from "@valiq-trading/core"
import type { ExtraToolsConfig, PreRunHookConfig } from "../types"

export const VALIQ_RESEARCH_SECRET_KEYS = [
    "VALIQ_API_URL",
    "VALIQ_AUTH_URL",
    "VALIQ_OAUTH_CLIENT_ID",
    "VALIQ_OAUTH_CLIENT_SECRET",
    "VALIQ_OAUTH_USER_UUID",
] as const

export const VALIQ_STANDARD_TOOL_SECRET_KEYS = [
    ...VALIQ_RESEARCH_SECRET_KEYS,
    ...VALIQ_DATA_SECRET_KEYS,
] as const

interface ValiqToolsOptions {
    research?: boolean
    data?: boolean
    breakingNews?: boolean
    missingDataLogMessage?: string
}

export function createValiqTools(
    config: ExtraToolsConfig,
    options: ValiqToolsOptions
): ToolDefinition[] {
    const tools: ToolDefinition[] = []

    if (options.research) {
        const researchTool = createResearchTool(config)
        if (researchTool) {
            tools.push(researchTool)
        }
    }

    if (options.data || options.breakingNews) {
        const data = createDataAdapter(config, options.missingDataLogMessage)
        if (data) {
            if (options.data) {
                tools.push(createValiqDataTool(data))
            }
            if (options.breakingNews) {
                tools.push(createValiqBreakingNewsTool(data))
            }
        }
    }

    return tools
}

export function appendValiqSecretKeys(keys: readonly string[]): string[] {
    return Array.from(new Set([
        ...keys,
        ...VALIQ_STANDARD_TOOL_SECRET_KEYS,
    ]))
}

export function appendValiqDataSecretKeys(keys: readonly string[]): string[] {
    return Array.from(new Set([
        ...keys,
        ...VALIQ_DATA_SECRET_KEYS,
    ]))
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

function createResearchTool(config: ExtraToolsConfig): ToolDefinition | null {
    const valiqUrl = config.secrets.VALIQ_API_URL
    const authUrl = config.secrets.VALIQ_AUTH_URL
    const clientId = config.secrets.VALIQ_OAUTH_CLIENT_ID
    const clientSecret = config.secrets.VALIQ_OAUTH_CLIENT_SECRET
    const userUuid = config.secrets.VALIQ_OAUTH_USER_UUID

    if (!valiqUrl || !authUrl || !clientId || !clientSecret || !userUuid) {
        const missing = VALIQ_RESEARCH_SECRET_KEYS.filter((key) => !config.secrets[key])
        const configured = VALIQ_RESEARCH_SECRET_KEYS.length - missing.length
        if (configured > 0) {
            config.runLogger.warn(
                "Valiq research tool NOT registered: missing secrets",
                { missing }
            )
        }
        return null
    }

    const tokenProvider = createOAuthTokenProvider({
        authUrl,
        clientId,
        clientSecret,
        userUuid,
        logger: config.runLogger,
    })

    const valiqClient = new ValiqClient({
        apiUrl: valiqUrl,
        tokenProvider,
        logger: config.runLogger,
    })
    const research = new ValiqResearchAdapter(valiqClient, config.runLogger)

    return createValiqResearchTool(research)
}

function createDataAdapter(
    config: ExtraToolsConfig,
    missingDataLogMessage: string = "Valiq data tools NOT registered: missing secrets"
): ValiqDataAdapter | null {
    const dataApi = resolveValiqDataApiConfig(config.secrets)

    if (!dataApi) {
        const missing = getMissingValiqDataApiSecrets(config.secrets)
        if (missing.length > 0) {
            config.runLogger.warn(
                missingDataLogMessage,
                { missing }
            )
        }
        return null
    }

    const dataClient = new ValiqDataClient({
        apiUrl: dataApi.apiUrl,
        apiKey: dataApi.apiKey,
        logger: config.runLogger,
    })

    return new ValiqDataAdapter(dataClient)
}

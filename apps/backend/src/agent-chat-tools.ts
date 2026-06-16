import {
    jsonSchema,
    tool,
    type ToolSet,
} from "ai"
import {
    ToolExecutionEngine,
    ToolRegistry,
    discoverHttpMcpToolInventory,
    resolveMcpProviderConfigs,
    type McpToolDiagnostic,
    type ToolBinding,
    type ToolManifestEntry,
} from "@valiq-trading/agent"
import type {
    Logger,
    VenueApp,
} from "@valiq-trading/core"
import type {
    Id,
    PortfolioFreshnessRow,
    StrategyMcpToolWhitelist,
    TradingBackendClient,
} from "@valiq-trading/convex"
import { z } from "zod/v4"
import {
    ALL_APPS,
    backend,
    healthState,
    logger,
    resolvedSecrets,
} from "./state"
import { createMcpTools } from "./plugins/shared"
import type {
    AccountHealthState,
    VenueHealthState,
} from "./types"

export interface BuildAgentChatToolRuntimeArgs {
    abortSignal: AbortSignal
    strategyId?: Id<"strategies">
    tradingBackend?: TradingBackendClient
    secrets?: Record<string, string | null | undefined>
    log?: Logger
    discoverMcpInventory?: typeof discoverHttpMcpToolInventory
    createScopedMcpTools?: typeof createMcpTools
}

export interface AgentChatToolRuntime {
    registry: ToolRegistry
    tools: ToolSet
    mcpProviders: Array<{
        id: string
        toolCount: number
        status: "available" | "unavailable"
        error?: string
    }>
}

interface AgentChatMcpInventoryContext {
    strategyId?: Id<"strategies">
    whitelist: StrategyMcpToolWhitelist | null
    executableTools: ToolBinding[]
}

const MAX_LIST_LIMIT = 100
const DEFAULT_LIST_LIMIT = 20
const CHAT_TOOL_TIMEOUT_MS = 30_000
const CHAT_RUN_TIMEOUT_MS = 120_000

const venueAppSchema = z.enum(ALL_APPS as [VenueApp, ...VenueApp[]])
const boundedIdSchema = z.string().trim().min(1).max(160)
const optionalScopeSchema = z.strictObject({
    app: venueAppSchema.optional(),
    accountId: boundedIdSchema.optional(),
    strategyId: boundedIdSchema.optional(),
})
const optionalLimitSchema = z.number().int().min(1).max(MAX_LIST_LIMIT).optional()

export async function buildAgentChatToolRuntime(
    args: BuildAgentChatToolRuntimeArgs
): Promise<AgentChatToolRuntime> {
    const tradingBackend = args.tradingBackend ?? backend
    const log = args.log ?? logger
    const secrets = args.secrets ?? resolvedSecrets
    const registry = new ToolRegistry()
    const mcpToolDiagnostics: McpToolDiagnostic[] = []
    const mcpInventoryContext: AgentChatMcpInventoryContext = {
        strategyId: args.strategyId,
        whitelist: null,
        executableTools: [],
    }

    for (const binding of createReadOnlyChatTools(tradingBackend, secrets, log, mcpInventoryContext)) {
        registry.register(binding)
    }

    const mcpProviderResolution = resolveAgentChatMcpProviderConfigs({
        secrets,
        logger: log,
        compatibleVenues: ALL_APPS,
    })
    const mcpDiscovery = await discoverAgentChatMcpInventory({
        providers: mcpProviderResolution.providers,
        logger: log,
        signal: args.abortSignal,
        discoverMcpInventory: args.discoverMcpInventory ?? discoverHttpMcpToolInventory,
    })
    const mcpToolWhitelist = args.strategyId
        ? await tradingBackend.getStrategyMcpToolWhitelist(args.strategyId)
        : null
    mcpInventoryContext.whitelist = mcpToolWhitelist
    const executableMcpTools = args.strategyId
        ? await (args.createScopedMcpTools ?? createMcpTools)({
            secrets: normalizeMcpSecrets(secrets),
            runLogger: log,
            mcpToolWhitelist,
            mcpToolDiagnostics,
            mcpToolRegistry: registry,
        })
        : []
    mcpInventoryContext.executableTools = executableMcpTools

    for (const binding of executableMcpTools) {
        registry.register(binding)
    }

    const engine = new ToolExecutionEngine({
        tools: registry,
        logger: log,
        runStartedAt: Date.now(),
        runTimeoutMs: CHAT_RUN_TIMEOUT_MS,
        maxToolTimeoutMs: CHAT_TOOL_TIMEOUT_MS,
    })

    return {
        registry,
        tools: createAiSdkTools(registry, engine),
        mcpProviders: [
            ...mcpProviderResolution.unavailable,
            ...mergeAgentChatMcpProviderStatuses(mcpDiscovery.providers, mcpToolWhitelist, executableMcpTools.length),
        ],
    }
}

export function listAgentChatTools(
    registry: ToolRegistry
): Array<ToolManifestEntry & {
    description: string
    outputDescription?: string
    errorSemantics?: string
}> {
    return registry.getAll().map((binding) => ({
        name: binding.name,
        category: binding.category,
        contractBoundary: binding.contractBoundary,
        contractOwner: binding.contractOwner,
        description: binding.description,
        outputDescription: binding.outputDescription,
        errorSemantics: binding.errorSemantics,
    }))
}

function createAiSdkTools(
    registry: ToolRegistry,
    engine: ToolExecutionEngine
): ToolSet {
    const entries = registry.getAll().map((binding) => [
        binding.name,
        tool({
            description: binding.description,
            inputSchema: binding.jsonSchema ? jsonSchema(binding.jsonSchema as never) : binding.parameters,
            execute: async (input, options) => {
                const result = await engine.executeMcpCall(binding.name, input, options.toolCallId, {
                    signal: options.abortSignal,
                })

                if (result.fatal || result.isError) {
                    throw new Error(result.content)
                }

                return parseToolContent(result.content)
            },
        }),
    ] as const)

    return Object.fromEntries(entries) as ToolSet
}

function createReadOnlyChatTools(
    tradingBackend: TradingBackendClient,
    secrets: Record<string, string | null | undefined>,
    log: Logger,
    mcpInventoryContext: AgentChatMcpInventoryContext
): ToolBinding[] {
    return [
        createChatTool({
            name: "list_strategies",
            description: "List configured strategies from the backend read model. Works when the list is empty.",
            parameters: z.strictObject({
                app: venueAppSchema.optional(),
                enabled: z.boolean().optional(),
            }),
            handler: async (params) => {
                const input = z.strictObject({
                    app: venueAppSchema.optional(),
                    enabled: z.boolean().optional(),
                }).parse(params)
                const strategies = await tradingBackend.getAllStrategies()
                return {
                    strategies: strategies
                        .filter((strategy) => !input.app || strategy.app === input.app)
                        .filter((strategy) => input.enabled === undefined || strategy.enabled === input.enabled)
                        .map((strategy) => ({
                            id: String(strategy._id),
                            app: strategy.app,
                            accountId: strategy.accountId,
                            name: strategy.name,
                            enabled: strategy.enabled,
                            schedule: strategy.schedule,
                            model: readStrategyModel(strategy.policy),
                            dryRun: readStrategyDryRun(strategy.policy),
                        })),
                }
            },
        }),
        createChatTool({
            name: "list_accounts",
            description: "List configured broker/account records without returning credentials or tokens.",
            parameters: z.strictObject({
                app: venueAppSchema.optional(),
            }),
            handler: async (params) => {
                const input = z.strictObject({
                    app: venueAppSchema.optional(),
                }).parse(params)
                const accounts = await tradingBackend.getAccounts(input.app)
                return {
                    accounts: accounts.map((account) => ({
                        id: String(account._id),
                        app: account.app,
                        accountId: account.accountId,
                        label: account.label,
                        status: account.status,
                    })),
                }
            },
        }),
        createChatTool({
            name: "get_account_state",
            description: "Read latest account snapshot state from Convex account snapshots for an optional app/account scope.",
            parameters: optionalScopeSchema.omit({ strategyId: true }),
            handler: async (params) => {
                const input = optionalScopeSchema.omit({ strategyId: true }).parse(params)
                const snapshots = await tradingBackend.getPortfolioAccountSnapshots(input.app, input.accountId)
                return { accountStates: snapshots }
            },
        }),
        createChatTool({
            name: "get_portfolio_state",
            description: "Read provider-sync freshness, latest account snapshots, positions, and working orders for an optional app/account/strategy scope.",
            parameters: optionalScopeSchema,
            handler: async (params) => {
                const input = optionalScopeSchema.parse(params)
                const [freshness, accountStates, positions, workingOrders] = await Promise.all([
                    tradingBackend.getPortfolioFreshness(input.app, input.accountId),
                    tradingBackend.getPortfolioAccountSnapshots(input.app, input.accountId),
                    tradingBackend.getPortfolioPositions(input.app, input.strategyId as Id<"strategies"> | undefined, input.accountId),
                    tradingBackend.getPortfolioPendingOrders(input.app, input.strategyId as Id<"strategies"> | undefined, input.accountId),
                ])

                return {
                    freshness,
                    accountStates,
                    positions,
                    workingOrders,
                }
            },
        }),
        createChatTool({
            name: "get_positions",
            description: "Read portfolio positions for an optional app/account/strategy scope.",
            parameters: optionalScopeSchema,
            handler: async (params) => {
                const input = optionalScopeSchema.parse(params)
                const positions = await tradingBackend.getPortfolioPositions(input.app, input.strategyId as Id<"strategies"> | undefined, input.accountId)
                return { positions }
            },
        }),
        createChatTool({
            name: "get_working_orders",
            description: "Read provider working orders for an optional app/account/strategy scope.",
            parameters: optionalScopeSchema,
            handler: async (params) => {
                const input = optionalScopeSchema.parse(params)
                const workingOrders = await tradingBackend.getPortfolioPendingOrders(input.app, input.strategyId as Id<"strategies"> | undefined, input.accountId)
                return { workingOrders }
            },
        }),
        createChatTool({
            name: "get_recent_runs",
            description: "Read recent strategy runs from Convex for an optional app/account/strategy scope.",
            parameters: optionalScopeSchema.extend({
                limit: optionalLimitSchema,
            }),
            handler: async (params) => {
                const input = optionalScopeSchema.extend({
                    limit: optionalLimitSchema,
                }).parse(params)
                const limit = input.limit ?? DEFAULT_LIST_LIMIT
                const strategies = input.strategyId
                    ? [await tradingBackend.getStrategyById(input.strategyId as Id<"strategies">)].filter(isNonNullable)
                    : (await tradingBackend.getAllStrategies())
                        .filter((strategy) => !input.app || strategy.app === input.app)
                        .filter((strategy) => !input.accountId || strategy.accountId === input.accountId)
                const runs = (await Promise.all(
                    strategies.map(async (strategy) => await tradingBackend.getRunHistory(strategy._id, limit))
                ))
                    .flat()
                    .sort((left, right) => right.startedAt - left.startedAt)
                    .slice(0, limit)
                const strategyById = new Map(strategies.map((strategy) => [String(strategy._id), strategy]))

                return {
                    runs: runs.map((run) => ({
                        id: String(run._id),
                        strategyId: String(run.strategyId),
                        app: run.app,
                        accountId: strategyById.get(String(run.strategyId))?.accountId,
                        status: run.status,
                        trigger: run.trigger,
                        startedAt: run.startedAt,
                        endedAt: run.endedAt,
                        summary: run.summary,
                        error: run.error,
                    })),
                }
            },
        }),
        createChatTool({
            name: "get_alerts",
            description: "Read recent system alerts for an optional severity/acknowledgement scope.",
            parameters: z.strictObject({
                severity: z.enum(["critical", "warning", "info"]).optional(),
                acknowledged: z.boolean().optional(),
                limit: optionalLimitSchema,
            }),
            handler: async (params) => {
                const input = z.strictObject({
                    severity: z.enum(["critical", "warning", "info"]).optional(),
                    acknowledged: z.boolean().optional(),
                    limit: optionalLimitSchema,
                }).parse(params)
                const alerts = await tradingBackend.getRecentAlerts({
                    severity: input.severity,
                    acknowledged: input.acknowledged,
                    limit: input.limit,
                })

                return { alerts }
            },
        }),
        createChatTool({
            name: "get_provider_health",
            description: "Read backend provider health and portfolio freshness without credentials.",
            parameters: z.strictObject({
                app: venueAppSchema.optional(),
                accountId: boundedIdSchema.optional(),
            }),
            handler: async (params) => {
                const input = z.strictObject({
                    app: venueAppSchema.optional(),
                    accountId: boundedIdSchema.optional(),
                }).parse(params)
                const [freshness, strategies] = await Promise.all([
                    tradingBackend.getPortfolioFreshness(input.app, input.accountId),
                    tradingBackend.getAllStrategies(),
                ])
                const strategyCount = strategies
                    .filter((strategy) => strategy.enabled)
                    .filter((strategy) => !input.app || strategy.app === input.app)
                    .filter((strategy) => !input.accountId || strategy.accountId === input.accountId)
                    .length

                return {
                    backendHealth: {
                        ready: healthState.ready,
                        startedAt: healthState.startedAt,
                        strategyCount,
                        venues: mergeVenueHealthWithFreshness(freshness),
                        lastRunAt: healthState.lastRunAt,
                        lastRunStatus: healthState.lastRunStatus,
                        lastRunError: healthState.lastRunError,
                    },
                    freshness,
                }
            },
        }),
        createChatTool({
            name: "inspect_mcp_inventory",
            description: "List server-side MCP providers and exposed MCP tools without returning MCP bearer tokens.",
            parameters: z.strictObject({}),
            handler: async () => {
                const providerResolution = resolveAgentChatMcpProviderConfigs({
                    secrets,
                    logger: log,
                    compatibleVenues: ALL_APPS,
                })
                const effectiveTools = describeEffectiveMcpTools(mcpInventoryContext)
                return {
                    strategyScope: describeMcpStrategyScope(mcpInventoryContext, effectiveTools.length),
                    providers: [
                        ...providerResolution.unavailable,
                        ...providerResolution.providers.map((provider) => ({
                            id: provider.id,
                            url: redactUrl(provider.url),
                            category: provider.category ?? "research",
                            hasBearerToken: Boolean(provider.token),
                            allowedTools: provider.allowedTools ?? [],
                            blockedTools: provider.blockedTools ?? [],
                            configuredAllowedTools: provider.allowedTools ?? null,
                            configuredBlockedTools: provider.blockedTools ?? null,
                            strategyApprovedTools: describeStrategyApprovedMcpTools(provider.id, mcpInventoryContext),
                            effectiveTools: effectiveTools.filter((tool) => tool.providerId === provider.id),
                            status: "configured" as const,
                        })),
                    ],
                }
            },
        }),
    ]
}

function mergeVenueHealthWithFreshness(
    freshness: PortfolioFreshnessRow[]
): Record<string, VenueHealthState> {
    const venues = structuredClone(healthState.venues)

    for (const row of freshness) {
        const venue = venues[row.app] ?? {
            validated: false,
            accounts: {},
        }
        const accounts = {
            ...(venue.accounts ?? {}),
        }
        const account = accounts[row.accountId] ?? {
            validated: venue.validated,
        }

        accounts[row.accountId] = {
            ...account,
            lastSyncAt: row.lastSyncedAt,
            lastVerifiedAt: row.lastVerifiedAt,
            providerStatus: row.providerStatus,
            stale: row.stale,
            driftDetected: row.driftDetected,
            positionCount: row.positionCount,
            pendingOrderCount: row.pendingOrderCount,
            lastSyncError: row.lastError,
        }

        venues[row.app] = {
            ...venue,
            accounts,
            ...rollUpAccountFreshness(accounts),
        }
    }

    return venues
}

function rollUpAccountFreshness(
    accounts: Record<string, AccountHealthState>
): Pick<
    VenueHealthState,
    "providerStatus" |
    "stale" |
    "driftDetected" |
    "positionCount" |
    "pendingOrderCount" |
    "lastSyncError" |
    "lastSyncAt" |
    "lastVerifiedAt"
> {
    const values = Object.values(accounts)
    const latestSync = maxDefined(values.map((account) => account.lastSyncAt))
    const latestVerified = maxDefined(values.map((account) => account.lastVerifiedAt))

    return {
        providerStatus: values.some((account) => account.providerStatus === "stale")
            ? "stale"
            : values.some((account) => account.providerStatus === "degraded")
                ? "degraded"
                : "healthy",
        stale: values.some((account) => account.stale === true),
        driftDetected: values.some((account) => account.driftDetected === true),
        positionCount: values.reduce((sum, account) => sum + (account.positionCount ?? 0), 0),
        pendingOrderCount: values.reduce((sum, account) => sum + (account.pendingOrderCount ?? 0), 0),
        lastSyncError: values.map((account) => account.lastSyncError).find((error) => error !== undefined),
        lastSyncAt: latestSync,
        lastVerifiedAt: latestVerified,
    }
}

function maxDefined(values: Array<number | undefined>): number | undefined {
    const finite = values.filter((value): value is number => value !== undefined && Number.isFinite(value))
    return finite.length > 0 ? Math.max(...finite) : undefined
}

function createChatTool(config: {
    name: string
    description: string
    parameters: z.ZodType<unknown>
    handler: ToolBinding["handler"]
}): ToolBinding {
    return {
        name: config.name,
        description: config.description,
        parameters: config.parameters,
        category: "account",
        contractBoundary: "shared",
        contractOwner: "agent-chat",
        outputDescription: "Returns bounded backend read-model data for dashboard chat.",
        errorSemantics: "Input validation and handler errors fail closed and are surfaced as AI SDK tool errors.",
        handler: config.handler,
    }
}

function parseToolContent(content: string): unknown {
    try {
        return JSON.parse(content) as unknown
    } catch {
        return content
    }
}

function readStrategyModel(policy: Record<string, unknown>): string {
    const llm = policy.llm && typeof policy.llm === "object"
        ? policy.llm as Record<string, unknown>
        : undefined
    const model = typeof llm?.model === "string"
        ? llm.model
        : typeof policy.model === "string"
            ? policy.model
            : undefined

    return model && model.trim().length > 0 ? model : "unconfigured"
}

function readStrategyDryRun(policy: Record<string, unknown>): boolean | undefined {
    return typeof policy.dryRun === "boolean" ? policy.dryRun : undefined
}

function redactUrl(value: string): string {
    try {
        const url = new URL(value)
        url.username = ""
        url.password = ""
        url.search = ""
        url.hash = ""
        return url.toString()
    } catch {
        return "[invalid-url]"
    }
}

function isNonNullable<T>(value: T): value is NonNullable<T> {
    return value !== null && value !== undefined
}

function describeMcpStrategyScope(
    context: AgentChatMcpInventoryContext,
    effectiveToolCount: number
) {
    if (!context.strategyId) {
        return {
            selected: false,
            strategyId: null,
            whitelistStatus: "not_selected" as const,
            approvedToolCount: 0,
            discoveryToolCount: 0,
            effectiveToolCount,
        }
    }

    if (!context.whitelist) {
        return {
            selected: true,
            strategyId: String(context.strategyId),
            whitelistStatus: "missing" as const,
            approvedToolCount: 0,
            discoveryToolCount: 0,
            effectiveToolCount,
        }
    }

    return {
        selected: true,
        strategyId: String(context.strategyId),
        whitelistStatus: context.whitelist.tools.length > 0 ? "configured" as const : "empty" as const,
        approvedToolCount: context.whitelist.tools.length,
        discoveryToolCount: context.whitelist.discoveryTools?.length ?? 0,
        effectiveToolCount,
    }
}

function describeStrategyApprovedMcpTools(
    providerId: string,
    context: AgentChatMcpInventoryContext
) {
    return (context.whitelist?.tools ?? [])
        .filter((tool) => tool.providerId === providerId)
        .map((tool) => ({
            toolName: tool.toolName,
            registeredName: tool.registeredName,
            schemaHash: tool.schemaHash,
        }))
}

function describeEffectiveMcpTools(context: AgentChatMcpInventoryContext) {
    const approvedToolByRegisteredName = new Map(
        (context.whitelist?.tools ?? []).map((tool) => [tool.registeredName, tool])
    )

    return context.executableTools.map((binding) => {
        const approvedTool = approvedToolByRegisteredName.get(binding.name)

        return {
            providerId: approvedTool?.providerId ?? readMcpProviderId(binding.contractOwner) ?? "[unresolved-provider]",
            toolName: approvedTool?.toolName ?? binding.name,
            registeredName: binding.name,
            category: binding.category ?? "research",
            description: binding.description,
        }
    })
}

function readMcpProviderId(contractOwner: string | undefined): string | undefined {
    const prefix = "mcp:"
    return contractOwner?.startsWith(prefix)
        ? contractOwner.slice(prefix.length)
        : undefined
}

function normalizeMcpSecrets(secrets: Record<string, string | null | undefined>): Record<string, string | null> {
    const normalized: Record<string, string | null> = {}

    for (const [key, value] of Object.entries(secrets)) {
        normalized[key] = value ?? null
    }

    return normalized
}

function mergeAgentChatMcpProviderStatuses(
    providers: AgentChatToolRuntime["mcpProviders"],
    whitelist: StrategyMcpToolWhitelist | null,
    executableToolCount: number
): AgentChatToolRuntime["mcpProviders"] {
    if (!whitelist || executableToolCount === 0) {
        return providers
    }

    const approvedToolsByProvider = new Map<string, number>()
    for (const tool of whitelist.tools) {
        approvedToolsByProvider.set(tool.providerId, (approvedToolsByProvider.get(tool.providerId) ?? 0) + 1)
    }

    return providers.map((provider) => {
        const approvedCount = approvedToolsByProvider.get(provider.id)
        if (!approvedCount || provider.status !== "available") {
            return provider
        }

        return {
            ...provider,
            toolCount: approvedCount,
        }
    })
}

function resolveAgentChatMcpProviderConfigs(args: {
    secrets: Record<string, string | null | undefined>
    logger: Logger
    compatibleVenues: readonly VenueApp[]
}): {
    providers: ReturnType<typeof resolveMcpProviderConfigs>
    unavailable: AgentChatToolRuntime["mcpProviders"]
} {
    try {
        return {
            providers: resolveMcpProviderConfigs(args),
            unavailable: [],
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        args.logger.error("MCP provider configuration unavailable for agent chat", {
            error: message,
        })
        return {
            providers: [],
            unavailable: [{
                id: "mcp_configuration",
                toolCount: 0,
                status: "unavailable",
                error: message,
            }],
        }
    }
}

async function discoverAgentChatMcpInventory(args: {
    providers: ReturnType<typeof resolveMcpProviderConfigs>
    logger: Logger
    signal: AbortSignal
    discoverMcpInventory: typeof discoverHttpMcpToolInventory
}): Promise<{
    providers: AgentChatToolRuntime["mcpProviders"]
}> {
    const providers: AgentChatToolRuntime["mcpProviders"] = []

    for (const provider of args.providers) {
        try {
            const inventory = await args.discoverMcpInventory({
                providers: [provider],
                logger: args.logger,
                signal: args.signal,
                failOnProviderError: false,
            })
            const providerUnavailable = inventory.diagnostics.some((diagnostic) =>
                diagnostic.providerId === provider.id && diagnostic.reason === "provider_unavailable"
            )
            providers.push({
                id: provider.id,
                toolCount: inventory.inventory.length,
                status: providerUnavailable ? "unavailable" : "available",
                error: providerUnavailable ? "MCP provider inventory unavailable" : undefined,
            })
        } catch (error) {
            args.logger.error("MCP provider inventory unavailable for agent chat", {
                providerId: provider.id,
                error: error instanceof Error ? error.name : typeof error,
            })
            providers.push({
                id: provider.id,
                toolCount: 0,
                status: "unavailable",
                error: "MCP provider inventory unavailable",
            })
        }
    }

    return {
        providers,
    }
}

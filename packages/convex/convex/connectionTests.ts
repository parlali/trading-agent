"use node"

import { action, type ActionCtx } from "./_generated/server"
import { internal } from "./_generated/api"
import { v } from "convex/values"
import { requireUser } from "./lib/authGuards"
import {
    buildAccountSecretKeyMap,
    createLogger,
    resolveAccountScopedSecretKeys,
    type VenueApp,
} from "@valiq-trading/core"
import {
    MCP_PROVIDER_SECRET_KEYS,
    ToolExecutionEngine,
    ToolRegistry,
    createHttpMcpToolBindingResolution,
    discoverHttpMcpToolInventory,
    resolveMcpProviderConfigs,
    withMcpToolCallBudget,
} from "@valiq-trading/agent"
import { createMcpConnectionProviderScope } from "./lib/mcpConnectionScope"
import {
    ALPACA_RUNTIME_SECRET_KEYS,
    AlpacaClient,
    AlpacaOptionsVenueAdapter,
    resolveAlpacaRuntimeConfig,
} from "@valiq-trading/alpaca-options"
import {
    OKX_RUNTIME_SECRET_KEYS,
    OKXClient,
    OKXVenueAdapter,
    resolveOKXRuntimeConfig,
} from "@valiq-trading/okx"
import {
    MT5_RUNTIME_SECRET_KEYS,
    MT5Client,
    MT5VenueAdapter,
    resolveMT5RuntimeConfig,
} from "@valiq-trading/mt5"
import {
    POLYMARKET_RUNTIME_SECRET_KEYS,
    PolymarketClient,
    PolymarketVenueAdapter,
    resolvePolymarketCredentials,
} from "@valiq-trading/polymarket"

type StepResult = {
    name: string
    ok: boolean
    data?: unknown
    error?: string
}

function env(key: string): string | null {
    return process.env[key]?.trim() || null
}

async function getAccountSecrets(
    ctx: ActionCtx,
    app: VenueApp,
    accountId: string,
    keys: readonly string[]
): Promise<Record<string, string | null>> {
    const account = await ctx.runQuery(internal.queries.getAccountByAppAndIdInternal, {
        app,
        accountId,
    })

    if (!account) {
        throw new Error(`No ${app} account ${accountId} is configured in the account pool`)
    }

    const scopedKeyMap = buildAccountSecretKeyMap(
        account,
        resolveAccountScopedSecretKeys(app, [...keys])
    )
    const secrets: Record<string, string | null> = {}

    for (const key of keys) {
        const scopedKey = scopedKeyMap.get(key)
        secrets[key] = env(scopedKey ?? key)
    }

    return secrets
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

async function fetchJson(
    url: string,
    init?: RequestInit,
    timeoutMs = 15_000
): Promise<{ ok: boolean; status: number; data?: unknown; error?: string }> {
    try {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

        const res = await fetch(url, { ...init, signal: controller.signal })
        clearTimeout(timeoutId)

        if (!res.ok) {
            const body = await res.text().catch(() => "")
            return { ok: false, status: res.status, error: `HTTP ${res.status}: ${body.slice(0, 500)}` }
        }

        const data = await res.json()
        return { ok: true, status: res.status, data }
    } catch (error: unknown) {
        return { ok: false, status: 0, error: getErrorMessage(error) }
    }
}

export const testBackendHealth = action({
    args: {},
    handler: async (ctx) => {
        await requireUser(ctx)
        const url = env("BACKEND_HEALTH_URL")
        if (!url) {
            return { ok: false, error: "BACKEND_HEALTH_URL not configured in Convex environment variables", steps: [] }
        }

        const result = await fetchJson(url)
        if (!result.ok) {
            return { ok: false, steps: [{ name: "Health", ok: false, error: result.error }] }
        }

        return { ok: true, steps: [{ name: "Health", ok: true, data: result.data }] }
    },
})

export const testMT5Connection = action({
    args: { accountId: v.string() },
    handler: async (ctx, args) => {
        await requireUser(ctx)

        const steps: StepResult[] = []
        let runtimeConfig: ReturnType<typeof resolveMT5RuntimeConfig>

        try {
            runtimeConfig = resolveMT5RuntimeConfig(await getAccountSecrets(ctx, "mt5", args.accountId, MT5_RUNTIME_SECRET_KEYS))
        } catch (error) {
            steps.push({
                name: "Runtime Config",
                ok: false,
                error: getErrorMessage(error),
            })
            return { ok: false, steps }
        }

        steps.push({
            name: "Runtime Config",
            ok: true,
            data: {
                workerUrl: runtimeConfig.workerUrl,
                login: runtimeConfig.credentials.login,
                server: runtimeConfig.credentials.server,
            },
        })

        const client = new MT5Client({
            workerUrl: runtimeConfig.workerUrl,
            accessKey: runtimeConfig.accessKey,
        })

        try {
            const health = await client.getHealth()
            steps.push({ name: "Worker Health", ok: true, data: health })
        } catch (error) {
            steps.push({ name: "Worker Health", ok: false, error: getErrorMessage(error) })
            return { ok: false, steps }
        }

        const venue = new MT5VenueAdapter(client, runtimeConfig.credentials)

        try {
            const accountState = await venue.getAccountState()
            steps.push({ name: "Account", ok: true, data: accountState })
        } catch (error) {
            steps.push({ name: "Account", ok: false, error: getErrorMessage(error) })
            return { ok: false, steps }
        }

        try {
            const positions = await venue.getPositions()
            steps.push({
                name: "Positions",
                ok: true,
                data: {
                    count: positions.length,
                    positions,
                },
            })
        } catch (error) {
            steps.push({ name: "Positions", ok: false, error: getErrorMessage(error) })
            return { ok: false, steps }
        }

        try {
            const workingOrders = await venue.getWorkingOrders()
            steps.push({
                name: "Working Orders",
                ok: true,
                data: {
                    count: workingOrders.length,
                    orders: workingOrders,
                },
            })
        } catch (error) {
            steps.push({ name: "Working Orders", ok: false, error: getErrorMessage(error) })
        }

        return { ok: steps.every((step) => step.ok), steps }
    },
})

export const testAlpacaConnection = action({
    args: { accountId: v.string() },
    handler: async (ctx, args) => {
        await requireUser(ctx)

        const steps: StepResult[] = []
        let runtimeConfig: ReturnType<typeof resolveAlpacaRuntimeConfig>

        try {
            runtimeConfig = resolveAlpacaRuntimeConfig(await getAccountSecrets(ctx, "alpaca-options", args.accountId, ALPACA_RUNTIME_SECRET_KEYS))
        } catch (error) {
            steps.push({
                name: "Runtime Config",
                ok: false,
                error: getErrorMessage(error),
            })
            return { ok: false, steps }
        }

        steps.push({
            name: "Runtime Config",
            ok: true,
            data: {
                environment: runtimeConfig.environment,
                tradingBaseUrl: runtimeConfig.tradingBaseUrl,
                marketDataBaseUrl: runtimeConfig.marketDataBaseUrl,
                accountId: runtimeConfig.credentials.accountId || null,
            },
        })

        const client = new AlpacaClient(runtimeConfig)
        const venue = new AlpacaOptionsVenueAdapter(client)

        try {
            const accountState = await venue.getAccountState()
            steps.push({ name: "Account", ok: true, data: accountState })
        } catch (error) {
            steps.push({ name: "Account", ok: false, error: getErrorMessage(error) })
            return { ok: false, steps }
        }

        try {
            const positions = await venue.getPositions()
            steps.push({
                name: "Positions",
                ok: true,
                data: {
                    count: positions.length,
                    positions,
                },
            })
        } catch (error) {
            steps.push({ name: "Positions", ok: false, error: getErrorMessage(error) })
            return { ok: false, steps }
        }

        try {
            const contracts = await venue.getOptionContracts({
                underlyingSymbol: "SPY",
                limit: 1,
            })
            steps.push({
                name: "Options Contracts",
                ok: true,
                data: {
                    underlyingSymbol: "SPY",
                    contractCount: contracts.contracts.length,
                    nextPageToken: contracts.nextPageToken,
                },
            })
        } catch (error) {
            steps.push({ name: "Options Contracts", ok: false, error: getErrorMessage(error) })
            return { ok: false, steps }
        }

        try {
            const quote = await venue.getQuote("SPY")
            steps.push({
                name: "Market Data",
                ok: true,
                data: {
                    symbol: "SPY",
                    quote,
                },
            })
        } catch (error) {
            steps.push({ name: "Market Data", ok: false, error: getErrorMessage(error) })
        }

        return { ok: steps.every((step) => step.ok), steps }
    },
})

export const testPolymarketConnection = action({
    args: { accountId: v.string() },
    handler: async (ctx, args) => {
        await requireUser(ctx)

        const steps: StepResult[] = []
        let credentials: ReturnType<typeof resolvePolymarketCredentials>

        try {
            credentials = resolvePolymarketCredentials(await getAccountSecrets(ctx, "polymarket", args.accountId, POLYMARKET_RUNTIME_SECRET_KEYS))
        } catch (error) {
            steps.push({
                name: "Runtime Config",
                ok: false,
                error: getErrorMessage(error),
            })
            return { ok: false, steps }
        }

        const client = new PolymarketClient(credentials)
        const venue = new PolymarketVenueAdapter(client)

        steps.push({
            name: "Runtime Config",
            ok: true,
            data: {
                signerAddress: client.getAddress(),
                funderAddress: client.getFunderAddress(),
                signatureType: client.getSignatureType(),
                host: credentials.host ?? null,
                chainId: credentials.chainId ?? null,
                orderOwner: "Orders will be created with POLYMARKET_FUNDER_ADDRESS as maker or owner",
            },
        })

        try {
            const markets = await client.getMarkets({ limit: 1, active: true })
            steps.push({
                name: "Public API",
                ok: true,
                data: {
                    reachable: true,
                    marketsReturned: markets.data.length,
                },
            })
        } catch (error) {
            steps.push({ name: "Public API", ok: false, error: getErrorMessage(error) })
            return { ok: false, steps }
        }

        try {
            const [balance, openOrders] = await Promise.all([
                client.getBalance(),
                client.getOpenOrders(),
            ])
            steps.push({
                name: "Authenticated Runtime Path",
                ok: true,
                data: {
                    balance,
                    openOrderCount: openOrders.length,
                    note: "Matches the backend plugin startup validation path",
                },
            })
        } catch (error) {
            steps.push({
                name: "Authenticated Runtime Path",
                ok: false,
                error: getErrorMessage(error),
            })
            return { ok: false, steps }
        }

        try {
            const accountState = await venue.getAccountState()
            steps.push({ name: "Account", ok: true, data: accountState })
        } catch (error) {
            steps.push({ name: "Account", ok: false, error: getErrorMessage(error) })
            return { ok: false, steps }
        }

        try {
            const positions = await venue.getPositions()
            steps.push({
                name: "Positions",
                ok: true,
                data: {
                    count: positions.length,
                    positions,
                },
            })
        } catch (error) {
            steps.push({ name: "Positions", ok: false, error: getErrorMessage(error) })
            return { ok: false, steps }
        }

        try {
            const workingOrders = await venue.getWorkingOrders()
            steps.push({
                name: "Open Bets",
                ok: true,
                data: {
                    count: workingOrders.length,
                    orders: workingOrders,
                },
            })
        } catch (error) {
            steps.push({ name: "Open Bets", ok: false, error: getErrorMessage(error) })
        }

        return { ok: steps.every((step) => step.ok), steps }
    },
})

export const testOKXConnection = action({
    args: { accountId: v.string() },
    handler: async (ctx, args) => {
        await requireUser(ctx)

        const steps: StepResult[] = []
        let runtimeConfig: ReturnType<typeof resolveOKXRuntimeConfig>

        try {
            runtimeConfig = resolveOKXRuntimeConfig(await getAccountSecrets(ctx, "okx-swap", args.accountId, OKX_RUNTIME_SECRET_KEYS))
        } catch (error) {
            steps.push({
                name: "Runtime Config",
                ok: false,
                error: getErrorMessage(error),
            })
            return { ok: false, steps }
        }

        steps.push({
            name: "Runtime Config",
            ok: true,
            data: {
                baseUrl: runtimeConfig.credentials.baseUrl ?? null,
                demoTrading: runtimeConfig.credentials.demoTrading,
                marginMode: runtimeConfig.marginMode,
                positionMode: runtimeConfig.positionMode,
            },
        })

        const client = new OKXClient(runtimeConfig.credentials)
        const venue = new OKXVenueAdapter(client, {
            marginMode: runtimeConfig.marginMode,
            positionMode: runtimeConfig.positionMode,
        })

        try {
            const publicTime = await client.getPublicTime()
            steps.push({ name: "Public API", ok: true, data: publicTime })
        } catch (error) {
            steps.push({ name: "Public API", ok: false, error: getErrorMessage(error) })
            return { ok: false, steps }
        }

        try {
            const accountState = await venue.getAccountState()
            steps.push({ name: "Account", ok: true, data: accountState })
        } catch (error) {
            steps.push({ name: "Account", ok: false, error: getErrorMessage(error) })
            return { ok: false, steps }
        }

        try {
            const positions = await venue.getPositions()
            steps.push({
                name: "Positions",
                ok: true,
                data: {
                    count: positions.length,
                    positions,
                },
            })
        } catch (error) {
            steps.push({ name: "Positions", ok: false, error: getErrorMessage(error) })
            return { ok: false, steps }
        }

        try {
            const marketPrice = await venue.getMarketPrice("BTC-USDT-SWAP")
            steps.push({ name: "Market Data", ok: true, data: marketPrice })
        } catch (error) {
            steps.push({ name: "Market Data", ok: false, error: getErrorMessage(error) })
        }

        return { ok: steps.every((step) => step.ok), steps }
    },
})

export const testMcpConnection = action({
    args: {
        strategyId: v.id("strategies"),
        toolName: v.optional(v.string()),
        toolArgs: v.optional(v.any()),
    },
    handler: async (ctx, args) => {
        await requireUser(ctx)
        const providers = resolveMcpProviderConfigs({
            secrets: readMcpConnectionSecrets(),
        })

        if (providers.length === 0) {
            return { ok: false, error: "No MCP provider configured. Set MCP_PROVIDER_CONFIGS or MCP_SERVER_URL in Convex environment variables", steps: [] }
        }

        const steps: StepResult[] = []

        try {
            steps.push({
                name: "Runtime Config",
                ok: true,
                data: {
                    providerIds: providers.map((provider) => provider.id),
                },
            })

            const inventory = await discoverHttpMcpToolInventory({
                providers,
                failOnProviderError: false,
            })

            const toolNames = inventory.inventory
                .map((tool) => tool.registeredName)
                .sort((left, right) => left.localeCompare(right))
            const providerUnavailable = inventory.diagnostics.some((diagnostic) =>
                diagnostic.reason === "provider_unavailable"
            )
            steps.push({
                name: "Discover Tools",
                ok: !providerUnavailable,
                data: {
                    toolNames,
                    diagnostics: inventory.diagnostics,
                },
                error: providerUnavailable ? "One or more MCP providers were unavailable" : undefined,
            })

            const whitelist = await ctx.runQuery(internal.queries.getStrategyMcpToolWhitelistInternal, {
                strategyId: args.strategyId,
            })
            if (!whitelist) {
                steps.push({
                    name: "Strategy Whitelist",
                    ok: false,
                    error: "Selected strategy has no persisted MCP tool whitelist",
                })
                return { ok: false, steps }
            }
            if (whitelist.tools.length === 0) {
                steps.push({
                    name: "Strategy Whitelist",
                    ok: false,
                    error: "Selected strategy whitelist contains no enabled MCP tools",
                })
                return { ok: false, steps }
            }

            const providerScope = createMcpConnectionProviderScope(providers, whitelist)
            const toolBindings = await createHttpMcpToolBindingResolution({
                providers: providerScope.providers,
                failOnProviderError: false,
            })
            const registry = new ToolRegistry()
            for (const tool of toolBindings.bindings) {
                registry.register(withMcpToolCallBudget(tool, 4))
            }
            steps.push({
                name: "Strategy Whitelist",
                ok: toolBindings.bindings.length > 0 && providerScope.missingProviderIds.length === 0,
                data: {
                    approvedTools: whitelist.tools.map((tool) => tool.registeredName),
                    registeredTools: toolBindings.bindings.map((tool) => tool.name),
                    missingProviderIds: providerScope.missingProviderIds,
                    diagnostics: toolBindings.diagnostics,
                },
                error: providerScope.missingProviderIds.length > 0
                    ? `Approved MCP provider is not configured: ${providerScope.missingProviderIds.join(", ")}`
                    : toolBindings.bindings.length === 0
                        ? "No persisted strategy MCP tools registered in runtime ToolRegistry"
                        : undefined,
            })
            if (toolBindings.bindings.length === 0 || providerScope.missingProviderIds.length > 0) {
                return { ok: false, steps }
            }

            if (args.toolName) {
                const approvedTool = whitelist.tools.find((tool) =>
                    tool.registeredName === args.toolName || tool.toolName === args.toolName
                )
                const callToolName = approvedTool?.registeredName ?? args.toolName
                if (!registry.has(callToolName)) {
                    steps.push({ name: "Call Tool", ok: false, error: `Tool ${callToolName} is not registered in runtime ToolRegistry` })
                    return { ok: false, steps }
                }

                const engine = new ToolExecutionEngine({
                    tools: registry,
                    context: createMcpConnectionRunContext(),
                    logger: createLogger({ minLevel: "fatal" }),
                    runStartedAt: Date.now(),
                    runTimeoutMs: 60_000,
                    maxRepeatedToolErrors: 1,
                })
                const result = await engine.executeMcpCall(callToolName, args.toolArgs ?? {}, "connection-test-call")
                const outcome = engine.getOutcome()
                steps.push({
                    name: "Call Tool",
                    ok: !result.isError && !outcome.fatalFault,
                    data: result,
                    error: result.isError ? result.content : outcome.fatalFault?.reason,
                })
            }
        } catch (error: unknown) {
            steps.push({ name: "MCP Request", ok: false, error: getErrorMessage(error) })
        }

        return { ok: steps.every((s) => s.ok), steps }
    },
})

function readMcpConnectionSecrets(): Record<string, string | null> {
    const secrets: Record<string, string | null> = {}
    for (const key of MCP_PROVIDER_SECRET_KEYS) {
        secrets[key] = env(key)
    }
    return secrets
}

function createMcpConnectionRunContext() {
    return {
        runId: "connection-test",
        strategyId: "connection-test",
        app: "polymarket" as const,
        timestamp: Date.now(),
        trigger: "manual" as const,
        positions: [],
        accountState: {
            balance: 0,
            equity: 0,
            buyingPower: 0,
            marginUsed: 0,
            marginAvailable: 0,
            openPnl: 0,
            dayPnl: 0,
        },
        policy: {},
        context: "MCP connection test",
    }
}

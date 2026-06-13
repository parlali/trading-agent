"use node"

import { action, type ActionCtx } from "./_generated/server"
import { internal } from "./_generated/api"
import { v } from "convex/values"
import { requireUser } from "./lib/authGuards"
import {
    buildAccountSecretKeyMap,
    resolveAccountScopedSecretKeys,
    type VenueApp,
} from "@valiq-trading/core"
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
        toolName: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        await requireUser(ctx)
        const serverUrl = env("MCP_SERVER_URL")
        const token = env("MCP_SERVER_TOKEN")

        if (!serverUrl) {
            return { ok: false, error: "MCP_SERVER_URL not configured in Convex environment variables", steps: [] }
        }

        const steps: StepResult[] = []
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
        }

        if (token) {
            headers.Authorization = `Bearer ${token}`
        }

        try {
            const initialize = await fetchJson(serverUrl, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "initialize",
                    params: {
                        protocolVersion: "2025-03-26",
                        capabilities: {},
                        clientInfo: {
                            name: "trading-dashboard-connection-test",
                            version: "1.0.0",
                        },
                    },
                }),
            })
            if (!initialize.ok) {
                steps.push({ name: "Initialize", ok: false, error: initialize.error })
                return { ok: false, steps }
            }
            steps.push({ name: "Initialize", ok: true, data: summarizeJsonRpcResult(initialize.data) })

            const tools = await fetchJson(serverUrl, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 2,
                    method: "tools/list",
                    params: {},
                }),
            })
            if (!tools.ok) {
                steps.push({ name: "List Tools", ok: false, error: tools.error })
                return { ok: false, steps }
            }

            const toolNames = readMcpToolNames(tools.data)
            steps.push({ name: "List Tools", ok: true, data: { toolNames } })

            if (args.toolName) {
                const call = await fetchJson(serverUrl, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                        jsonrpc: "2.0",
                        id: 3,
                        method: "tools/call",
                        params: {
                            name: args.toolName,
                            arguments: {},
                        },
                    }),
                })
                steps.push({
                    name: "Call Tool",
                    ok: call.ok,
                    data: call.ok ? summarizeJsonRpcResult(call.data) : undefined,
                    error: call.ok ? undefined : call.error,
                })
            }
        } catch (error: unknown) {
            steps.push({ name: "MCP Request", ok: false, error: getErrorMessage(error) })
        }

        return { ok: steps.every((s) => s.ok), steps }
    },
})

function summarizeJsonRpcResult(value: unknown): unknown {
    if (!value || typeof value !== "object") {
        return value
    }

    const record = value as Record<string, unknown>
    return "result" in record ? record.result : value
}

function readMcpToolNames(value: unknown): string[] {
    const result = summarizeJsonRpcResult(value)
    if (!result || typeof result !== "object") {
        return []
    }

    const tools = (result as Record<string, unknown>).tools
    if (!Array.isArray(tools)) {
        return []
    }

    return tools
        .map((tool) => tool && typeof tool === "object" ? (tool as Record<string, unknown>).name : undefined)
        .filter((name): name is string => typeof name === "string")
}

import { mt5PolicySchema, type MT5Policy } from "@valiq-trading/core"
import type { MT5AccountCredentials } from "./mt5-client"
import { FiveSocketClient, type FiveSocketExecutionSymbolPolicy } from "./fivesocket-client"
import {
    resolveMT5AllowedSymbols,
    resolveMT5ConfiguredSymbols,
} from "./symbols"

export const MT5_RUNTIME_SECRET_KEYS = [
    "FIVESOCKET_API_BASE_URL",
    "FIVESOCKET_API_KEY",
    "FIVESOCKET_DEFAULT_MAX_VOLUME",
    "MT5_LOGIN",
    "MT5_PASSWORD",
    "MT5_SERVER",
] as const

const DEFAULT_MT5_CREDENTIAL_ENV_PREFIX = "MT5_PRIMARY"

export interface MT5RuntimeConfig {
    baseUrl: string
    apiKey: string
    defaultMaxVolume: string
    credentialEnvPrefix: string
    credentials: MT5AccountCredentials
}

type MT5ClientPoolEntry = {
    client: FiveSocketClient
    configKey: string
    fetchImpl?: typeof fetch
}

type MT5ClientOptions = {
    executionSymbols?: readonly FiveSocketExecutionSymbolPolicy[]
    timeout?: number
    connectTimeout?: number
    minRequestIntervalMs?: number
    fetchImpl?: typeof fetch
}

const mt5ClientPool = new Map<string, MT5ClientPoolEntry>()

export function resolveMT5RuntimeConfig(
    secrets: Record<string, string | null>,
    env: NodeJS.ProcessEnv = process.env,
    credentialEnvPrefix = DEFAULT_MT5_CREDENTIAL_ENV_PREFIX
): MT5RuntimeConfig {
    assertMT5TransportGuard(secrets, env)
    const normalizedCredentialEnvPrefix = credentialEnvPrefix.trim()

    const credentials: MT5AccountCredentials = {
        login: Number(resolveMT5AccountSecret(secrets, env, normalizedCredentialEnvPrefix, "LOGIN")),
        password: resolveMT5AccountSecret(secrets, env, normalizedCredentialEnvPrefix, "PASSWORD"),
        server: resolveMT5AccountSecret(secrets, env, normalizedCredentialEnvPrefix, "SERVER"),
    }

    const baseUrl = (
        secrets.FIVESOCKET_API_BASE_URL
        ?? env.FIVESOCKET_API_BASE_URL
        ?? "https://api.fivesocket.com"
    ).trim().replace(/\/$/, "")
    const apiKey = (secrets.FIVESOCKET_API_KEY ?? env.FIVESOCKET_API_KEY ?? "").trim()
    if (!apiKey) {
        throw new Error("Missing required secret: FIVESOCKET_API_KEY")
    }
    const defaultMaxVolume = (
        secrets.FIVESOCKET_DEFAULT_MAX_VOLUME
        ?? env.FIVESOCKET_DEFAULT_MAX_VOLUME
        ?? ""
    ).trim()
    if (!defaultMaxVolume) {
        throw new Error("Missing required secret: FIVESOCKET_DEFAULT_MAX_VOLUME")
    }
    if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(defaultMaxVolume) || Number(defaultMaxVolume) <= 0) {
        throw new Error("FIVESOCKET_DEFAULT_MAX_VOLUME must be a positive plain decimal string")
    }

    return {
        baseUrl,
        apiKey,
        defaultMaxVolume,
        credentialEnvPrefix: normalizedCredentialEnvPrefix,
        credentials,
    }
}

function resolveMT5AccountSecret(
    secrets: Record<string, string | null>,
    env: NodeJS.ProcessEnv,
    credentialEnvPrefix: string,
    suffix: "LOGIN" | "PASSWORD" | "SERVER"
): string {
    const normalizedPrefix = credentialEnvPrefix.trim()
    if (!normalizedPrefix) {
        throw new Error(
            `MT5 account has an empty credentialEnvPrefix; refusing to resolve ${suffix} against a default account`
        )
    }
    const canonicalKey = `MT5_${suffix}`
    const scopedKey = `${normalizedPrefix}_${suffix}`
    const value = secrets[canonicalKey] ?? secrets[scopedKey] ?? env[scopedKey]

    if (!value) {
        throw new Error(
            `Missing required secret: ${scopedKey}. Set this in Convex environment variables.`
        )
    }

    return value
}

export function createMT5Client(
    runtime: MT5RuntimeConfig,
    options: MT5ClientOptions = {}
): FiveSocketClient {
    const poolKey = resolveMT5ClientPoolKey(runtime)
    const configKey = resolveMT5ClientPoolConfigKey(runtime, options)
    const existing = mt5ClientPool.get(poolKey)

    if (existing) {
        assertCompatibleMT5ClientPoolEntry(poolKey, existing, configKey, options.fetchImpl)
        if (options.executionSymbols !== undefined) {
            existing.client.updateExecutionSymbols(options.executionSymbols)
        }
        return existing.client
    }

    const client = new FiveSocketClient({
        baseUrl: runtime.baseUrl,
        apiKey: runtime.apiKey,
        executionSymbols: options.executionSymbols,
        timeout: options.timeout,
        connectTimeout: options.connectTimeout,
        minRequestIntervalMs: options.minRequestIntervalMs,
        fetchImpl: options.fetchImpl,
    })
    mt5ClientPool.set(poolKey, {
        client,
        configKey,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    })
    return client
}

export function resetMT5ClientPoolForTests(): void {
    mt5ClientPool.clear()
}

function resolveMT5ClientPoolKey(runtime: MT5RuntimeConfig): string {
    const prefix = runtime.credentialEnvPrefix.trim()
    const accountIdentity = `${runtime.credentials.login}:${runtime.credentials.server}`
    return prefix
        ? `prefix:${prefix}:account:${accountIdentity}`
        : `account:${accountIdentity}`
}

function resolveMT5ClientPoolConfigKey(
    runtime: MT5RuntimeConfig,
    options: MT5ClientOptions
): string {
    return JSON.stringify({
        baseUrl: runtime.baseUrl,
        apiKey: runtime.apiKey,
        timeout: options.timeout ?? null,
        connectTimeout: options.connectTimeout ?? null,
        minRequestIntervalMs: options.minRequestIntervalMs ?? null,
        fetchImpl: options.fetchImpl ? "custom" : "default",
    })
}

function assertCompatibleMT5ClientPoolEntry(
    poolKey: string,
    entry: MT5ClientPoolEntry,
    configKey: string,
    fetchImpl: typeof fetch | undefined
): void {
    if (entry.configKey === configKey && entry.fetchImpl === fetchImpl) {
        return
    }

    throw new Error(
        `MT5 FiveSocket client pool key ${poolKey} was requested with different transport options; restart the process or use the existing pooled configuration`
    )
}

export function toFiveSocketExecutionSymbols(
    symbols: readonly string[],
    maxVolume: string
): FiveSocketExecutionSymbolPolicy[] {
    const normalizedMaxVolume = maxVolume.trim()
    if (!normalizedMaxVolume) {
        throw new Error("FiveSocket maxVolume is required")
    }
    if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(normalizedMaxVolume) || Number(normalizedMaxVolume) <= 0) {
        throw new Error(`FiveSocket maxVolume must be a positive plain decimal string, received: ${maxVolume}`)
    }

    return symbols.map((symbol) => ({
        symbol,
        maxVolume: normalizedMaxVolume,
    }))
}

export function resolveFiveSocketExecutionSymbolsForPolicies(
    policies: readonly MT5Policy[],
    defaultMaxVolume: string
): FiveSocketExecutionSymbolPolicy[] {
    const symbols = resolveMT5AllowedSymbols(
        policies.flatMap((policy) => resolveMT5ConfiguredSymbols(policy))
    )
    return toFiveSocketExecutionSymbols(symbols, defaultMaxVolume)
}

export type FiveSocketAccountExecutionPolicySource = {
    enabled: boolean
    policy: unknown
}

export function resolveCanonicalFiveSocketAccountExecutionSymbols(
    strategies: readonly FiveSocketAccountExecutionPolicySource[],
    defaultMaxVolume: string
): FiveSocketExecutionSymbolPolicy[] {
    const policies = strategies
        .filter((strategy) => strategy.enabled)
        .map((strategy) => mt5PolicySchema.parse(strategy.policy))
    return resolveFiveSocketExecutionSymbolsForPolicies(policies, defaultMaxVolume)
}

function assertMT5TransportGuard(
    secrets: Record<string, string | null>,
    env: NodeJS.ProcessEnv
): void {
    const raw = secrets.MT5_TRANSPORT ?? env.MT5_TRANSPORT
    if (raw === undefined || raw === null) {
        return
    }

    const normalized = raw.trim().toLowerCase()
    if (normalized === "fivesocket" || normalized === "five-socket" || normalized === "fs") {
        return
    }

    throw new Error("MT5 worker transport has been removed; unset MT5_TRANSPORT (FiveSocket is the only transport)")
}

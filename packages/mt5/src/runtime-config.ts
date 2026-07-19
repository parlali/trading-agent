import { requireResolvedSecret, mt5PolicySchema, type MT5Policy } from "@valiq-trading/core"
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
    credentials: MT5AccountCredentials
}

export function resolveMT5RuntimeConfig(
    secrets: Record<string, string | null>,
    env: NodeJS.ProcessEnv = process.env,
    credentialEnvPrefix = DEFAULT_MT5_CREDENTIAL_ENV_PREFIX
): MT5RuntimeConfig {
    assertMT5TransportGuard(secrets, env)

    const credentials: MT5AccountCredentials = {
        login: Number(resolveMT5AccountSecret(secrets, env, credentialEnvPrefix, "LOGIN")),
        password: resolveMT5AccountSecret(secrets, env, credentialEnvPrefix, "PASSWORD"),
        server: resolveMT5AccountSecret(secrets, env, credentialEnvPrefix, "SERVER"),
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
    const scopedKey = `${normalizedPrefix}_${suffix}`
    const value = secrets[scopedKey] ?? env[scopedKey]

    if (!value) {
        throw new Error(
            `Missing required secret: ${scopedKey}. Set this in Convex environment variables.`
        )
    }

    return value
}

export function createMT5Client(
    runtime: MT5RuntimeConfig,
    options: {
        executionSymbols?: readonly FiveSocketExecutionSymbolPolicy[]
        timeout?: number
        connectTimeout?: number
        fetchImpl?: typeof fetch
    } = {}
): FiveSocketClient {
    return new FiveSocketClient({
        baseUrl: runtime.baseUrl,
        apiKey: runtime.apiKey,
        executionSymbols: options.executionSymbols,
        timeout: options.timeout,
        connectTimeout: options.connectTimeout,
        fetchImpl: options.fetchImpl,
    })
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

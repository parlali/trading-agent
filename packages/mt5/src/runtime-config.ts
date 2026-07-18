import { requireResolvedSecret, type MT5Policy } from "@valiq-trading/core"
import type { MT5WorkerCredentials } from "./mt5-client"
import { MT5Client } from "./mt5-client"
import {
    FiveSocketClient,
    type FiveSocketExecutionSymbolPolicy,
} from "./fivesocket-client"
import {
    resolveMT5AllowedSymbols,
    resolveMT5ConfiguredSymbols,
} from "./symbols"

export const MT5_RUNTIME_SECRET_KEYS = [
    "MT5_TRANSPORT",
    "MT5_WORKER_URL",
    "MT5_WORKER_ACCESS_KEY",
    "FIVESOCKET_API_BASE_URL",
    "FIVESOCKET_API_KEY",
    "FIVESOCKET_DEFAULT_MAX_VOLUME",
    "MT5_PRIMARY_LOGIN",
    "MT5_PRIMARY_PASSWORD",
    "MT5_PRIMARY_SERVER",
] as const

export type MT5TransportKind = "worker" | "fivesocket"

export interface MT5WorkerRuntimeConfig {
    transport: "worker"
    workerUrl: string
    accessKey: string
    credentials: MT5WorkerCredentials
}

export interface MT5FiveSocketRuntimeConfig {
    transport: "fivesocket"
    baseUrl: string
    apiKey: string
    defaultMaxVolume: string
    credentials: MT5WorkerCredentials
}

export type MT5RuntimeConfig = MT5WorkerRuntimeConfig | MT5FiveSocketRuntimeConfig

export function resolveMT5Transport(
    secrets: Record<string, string | null>,
    env: NodeJS.ProcessEnv = process.env
): MT5TransportKind {
    const raw = (secrets.MT5_TRANSPORT ?? env.MT5_TRANSPORT ?? "worker").trim().toLowerCase()
    if (raw === "fivesocket" || raw === "five-socket" || raw === "fs") {
        return "fivesocket"
    }
    if (raw === "worker" || raw === "mt5-worker" || raw === "") {
        return "worker"
    }
    throw new Error(`MT5_TRANSPORT must be "worker" or "fivesocket", received: ${raw}`)
}

export function resolveMT5RuntimeConfig(
    secrets: Record<string, string | null>,
    env: NodeJS.ProcessEnv = process.env
): MT5RuntimeConfig {
    const credentials: MT5WorkerCredentials = {
        login: Number(requireResolvedSecret(secrets, "MT5_PRIMARY_LOGIN")),
        password: requireResolvedSecret(secrets, "MT5_PRIMARY_PASSWORD"),
        server: requireResolvedSecret(secrets, "MT5_PRIMARY_SERVER"),
    }

    const transport = resolveMT5Transport(secrets, env)
    if (transport === "fivesocket") {
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
            transport: "fivesocket",
            baseUrl,
            apiKey,
            defaultMaxVolume,
            credentials,
        }
    }

    return {
        transport: "worker",
        workerUrl: requireResolvedSecret(secrets, "MT5_WORKER_URL"),
        accessKey: requireResolvedSecret(secrets, "MT5_WORKER_ACCESS_KEY"),
        credentials,
    }
}

export function createMT5TransportClient(
    runtime: MT5RuntimeConfig,
    options: {
        executionSymbols?: readonly FiveSocketExecutionSymbolPolicy[]
        timeout?: number
        connectTimeout?: number
        fetchImpl?: typeof fetch
    } = {}
): MT5Client {
    if (runtime.transport === "fivesocket") {
        return new FiveSocketClient({
            baseUrl: runtime.baseUrl,
            apiKey: runtime.apiKey,
            executionSymbols: options.executionSymbols,
            timeout: options.timeout,
            connectTimeout: options.connectTimeout,
            fetchImpl: options.fetchImpl,
        })
    }

    return new MT5Client({
        workerUrl: runtime.workerUrl,
        accessKey: runtime.accessKey,
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

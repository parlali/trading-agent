import { requireResolvedSecret } from "@valiq-trading/core"

export const ALPACA_RUNTIME_SECRET_KEYS = [
    "ALPACA_PRIMARY_API_KEY",
    "ALPACA_PRIMARY_SECRET_KEY",
    "ALPACA_PRIMARY_ENVIRONMENT",
    "ALPACA_ACCOUNT_ID",
] as const

export type AlpacaEnvironment = "paper" | "live"

export interface AlpacaCredentials {
    apiKey: string
    secretKey: string
    accountId: string
}

export interface AlpacaRuntimeConfig {
    environment: AlpacaEnvironment
    tradingBaseUrl: string
    marketDataBaseUrl: string
    credentials: AlpacaCredentials
}

const ALPACA_ENVIRONMENT_HOSTS: Record<AlpacaEnvironment, {
    tradingBaseUrl: string
    marketDataBaseUrl: string
}> = {
    paper: {
        tradingBaseUrl: "https://paper-api.alpaca.markets",
        marketDataBaseUrl: "https://data.alpaca.markets",
    },
    live: {
        tradingBaseUrl: "https://api.alpaca.markets",
        marketDataBaseUrl: "https://data.alpaca.markets",
    },
}

export function resolveAlpacaCredentials(
    secrets: Record<string, string | null>
): AlpacaCredentials {
    return {
        apiKey: requireResolvedSecret(secrets, "ALPACA_PRIMARY_API_KEY"),
        secretKey: requireResolvedSecret(secrets, "ALPACA_PRIMARY_SECRET_KEY"),
        accountId: secrets.ALPACA_ACCOUNT_ID ?? "",
    }
}

export function resolveAlpacaEnvironment(
    baseUrl: string
): "paper" | "live" {
    const normalized = baseUrl.trim().toLowerCase()

    if (normalized === "paper" || normalized === "live") {
        return normalized
    }

    throw new Error(
        `Invalid Alpaca environment "${baseUrl}". Set ALPACA_PRIMARY_ENVIRONMENT to "paper" or "live".`
    )
}

export function resolveAlpacaTradingBaseUrl(
    environment: AlpacaEnvironment
): string {
    return ALPACA_ENVIRONMENT_HOSTS[environment].tradingBaseUrl
}

export function resolveAlpacaMarketDataBaseUrl(
    environment: AlpacaEnvironment
): string {
    return ALPACA_ENVIRONMENT_HOSTS[environment].marketDataBaseUrl
}

export function resolveAlpacaRuntimeConfig(
    secrets: Record<string, string | null>
): AlpacaRuntimeConfig {
    const environment = resolveAlpacaEnvironment(
        requireResolvedSecret(secrets, "ALPACA_PRIMARY_ENVIRONMENT")
    )

    return {
        environment,
        tradingBaseUrl: resolveAlpacaTradingBaseUrl(environment),
        marketDataBaseUrl: resolveAlpacaMarketDataBaseUrl(environment),
        credentials: resolveAlpacaCredentials(secrets),
    }
}

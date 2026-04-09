import { requireResolvedSecret } from "@valiq-trading/core"
import type { BinanceCredentials } from "./binance-client"

export const BINANCE_RUNTIME_SECRET_KEYS = [
    "BINANCE_API_KEY",
    "BINANCE_API_SECRET",
    "BINANCE_BASE_URL",
] as const

export function resolveBinanceCredentials(
    secrets: Record<string, string | null>
): BinanceCredentials {
    return {
        apiKey: requireResolvedSecret(secrets, "BINANCE_API_KEY"),
        apiSecret: requireResolvedSecret(secrets, "BINANCE_API_SECRET"),
        baseUrl: secrets.BINANCE_BASE_URL ?? undefined,
    }
}

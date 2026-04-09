import { requireResolvedSecret } from "@valiq-trading/core";
export const BINANCE_RUNTIME_SECRET_KEYS = [
    "BINANCE_API_KEY",
    "BINANCE_API_SECRET",
    "BINANCE_BASE_URL",
];
export function resolveBinanceCredentials(secrets) {
    return {
        apiKey: requireResolvedSecret(secrets, "BINANCE_API_KEY"),
        apiSecret: requireResolvedSecret(secrets, "BINANCE_API_SECRET"),
        baseUrl: secrets.BINANCE_BASE_URL ?? undefined,
    };
}

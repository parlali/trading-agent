export declare const ALPACA_RUNTIME_SECRET_KEYS: readonly ["ALPACA_PRIMARY_API_KEY", "ALPACA_PRIMARY_SECRET_KEY", "ALPACA_PRIMARY_ENVIRONMENT", "ALPACA_ACCOUNT_ID"];
export type AlpacaEnvironment = "paper" | "live";
export interface AlpacaCredentials {
    apiKey: string;
    secretKey: string;
    accountId: string;
}
export interface AlpacaRuntimeConfig {
    environment: AlpacaEnvironment;
    tradingBaseUrl: string;
    marketDataBaseUrl: string;
    credentials: AlpacaCredentials;
}
export declare function resolveAlpacaCredentials(secrets: Record<string, string | null>): AlpacaCredentials;
export declare function resolveAlpacaEnvironment(baseUrl: string): "paper" | "live";
export declare function resolveAlpacaTradingBaseUrl(environment: AlpacaEnvironment): string;
export declare function resolveAlpacaMarketDataBaseUrl(environment: AlpacaEnvironment): string;
export declare function resolveAlpacaRuntimeConfig(secrets: Record<string, string | null>): AlpacaRuntimeConfig;
//# sourceMappingURL=runtime-config.d.ts.map
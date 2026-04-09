import type { PolymarketCredentials } from "./polymarket-client";
export declare const POLYMARKET_RUNTIME_SECRET_KEYS: readonly ["POLYMARKET_PRIVATE_KEY", "POLYMARKET_API_KEY", "POLYMARKET_API_SECRET", "POLYMARKET_API_PASSPHRASE", "POLYMARKET_HOST", "POLYMARKET_CHAIN_ID", "POLYMARKET_FUNDER_ADDRESS"];
export declare function resolvePolymarketFunderAddress(secrets: Record<string, string | null>): string;
export declare function resolvePolymarketCredentials(secrets: Record<string, string | null>): PolymarketCredentials;
//# sourceMappingURL=runtime-config.d.ts.map
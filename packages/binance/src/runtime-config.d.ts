import type { BinanceCredentials } from "./binance-client";
export declare const BINANCE_RUNTIME_SECRET_KEYS: readonly ["BINANCE_API_KEY", "BINANCE_API_SECRET", "BINANCE_BASE_URL"];
export declare function resolveBinanceCredentials(secrets: Record<string, string | null>): BinanceCredentials;
//# sourceMappingURL=runtime-config.d.ts.map
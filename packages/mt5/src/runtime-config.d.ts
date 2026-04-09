import type { MT5WorkerCredentials } from "./mt5-client";
export declare const MT5_RUNTIME_SECRET_KEYS: readonly ["MT5_WORKER_URL", "MT5_WORKER_ACCESS_KEY", "MT5_PRIMARY_LOGIN", "MT5_PRIMARY_PASSWORD", "MT5_PRIMARY_SERVER"];
export interface MT5RuntimeConfig {
    workerUrl: string;
    accessKey: string;
    credentials: MT5WorkerCredentials;
}
export declare function resolveMT5RuntimeConfig(secrets: Record<string, string | null>): MT5RuntimeConfig;
//# sourceMappingURL=runtime-config.d.ts.map
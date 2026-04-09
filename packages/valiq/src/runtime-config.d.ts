export declare const VALIQ_DATA_SECRET_KEYS: readonly ["VALIQ_DATA_API_URL", "VALIQ_DATA_API"];
export interface ValiqDataApiConfig {
    apiUrl: string;
    apiKey: string;
}
export declare function resolveValiqDataApiConfig(secrets: Record<string, string | null>): ValiqDataApiConfig | null;
export declare function getMissingValiqDataApiSecrets(secrets: Record<string, string | null>): string[];
//# sourceMappingURL=runtime-config.d.ts.map
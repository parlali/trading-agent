import { type Logger } from "@valiq-trading/core";
export type TokenProvider = () => Promise<string>;
export interface ValiqClientConfig {
    apiUrl: string;
    tokenProvider: TokenProvider;
    timeout?: number;
    logger?: Logger;
}
export declare class ValiqClient {
    private config;
    private logger?;
    constructor(config: ValiqClientConfig);
    private resolveToken;
    request<T>(path: string, options?: RequestInit): Promise<T>;
    requestSSE(path: string, body: Record<string, unknown>, options?: {
        timeout?: number;
    }): Promise<ReadableStream<Uint8Array>>;
}
export interface ValiqDataClientConfig {
    apiUrl: string;
    apiKey: string;
    timeout?: number;
    logger?: Logger;
}
export declare class ValiqDataClient {
    private config;
    private logger?;
    constructor(config: ValiqDataClientConfig);
    request<T>(path: string, options?: RequestInit): Promise<T>;
}
export declare function createStaticTokenProvider(token: string): TokenProvider;
export interface OAuthTokenProviderConfig {
    authUrl: string;
    clientId: string;
    clientSecret: string;
    userUuid: string;
    logger?: Logger;
}
export declare function createOAuthTokenProvider(config: OAuthTokenProviderConfig): TokenProvider;
//# sourceMappingURL=client.d.ts.map
import { retryWithBackoff } from "@valiq-trading/core";
export class ValiqClient {
    config;
    logger;
    constructor(config) {
        this.config = config;
        this.logger = config.logger;
    }
    async resolveToken() {
        return this.config.tokenProvider();
    }
    async request(path, options) {
        const url = `${this.config.apiUrl}${path}`;
        this.logger?.debug("ValiqClient request", { method: options?.method ?? "GET", path });
        const token = await this.resolveToken();
        const doFetch = async () => {
            const response = await retryWithBackoff(() => fetch(url, {
                ...options,
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                    ...options?.headers,
                },
                signal: AbortSignal.timeout(this.config.timeout ?? 30_000),
            }), 3, 1000);
            return response;
        };
        let response = await doFetch();
        if (response.status === 401) {
            this.logger?.debug("ValiqClient got 401, refreshing token", { path });
            const freshToken = await this.resolveToken();
            response = await retryWithBackoff(() => fetch(url, {
                ...options,
                headers: {
                    Authorization: `Bearer ${freshToken}`,
                    "Content-Type": "application/json",
                    ...options?.headers,
                },
                signal: AbortSignal.timeout(this.config.timeout ?? 30_000),
            }), 3, 1000);
        }
        if (!response.ok) {
            const body = await response.text().catch(() => "");
            this.logger?.error("ValiqClient request failed", {
                path,
                status: response.status,
                body: body.slice(0, 500),
            });
            throw new Error(`Val-iQ API error: ${response.status} ${response.statusText}`);
        }
        const result = (await response.json());
        this.logger?.debug("ValiqClient response ok", { path });
        return result;
    }
    async requestSSE(path, body, options) {
        const url = `${this.config.apiUrl}${path}`;
        const timeout = options?.timeout ?? 120_000;
        this.logger?.debug("ValiqClient SSE request", { path });
        const token = await this.resolveToken();
        const response = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                Accept: "text/event-stream",
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeout),
        });
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            this.logger?.error("ValiqClient SSE request failed", {
                path,
                status: response.status,
                body: text.slice(0, 500),
            });
            throw new Error(`Val-iQ SSE error: ${response.status} ${response.statusText}`);
        }
        if (!response.body) {
            throw new Error("Val-iQ SSE response has no body");
        }
        return response.body;
    }
}
export class ValiqDataClient {
    config;
    logger;
    constructor(config) {
        this.config = config;
        this.logger = config.logger;
    }
    async request(path, options) {
        const url = `${this.config.apiUrl}${path}`;
        this.logger?.debug("ValiqDataClient request", { method: options?.method ?? "GET", path });
        const response = await retryWithBackoff(() => fetch(url, {
            ...options,
            headers: {
                "X-API-Key": this.config.apiKey,
                "Content-Type": "application/json",
                ...options?.headers,
            },
            signal: AbortSignal.timeout(this.config.timeout ?? 30_000),
        }), 3, 1000);
        if (!response.ok) {
            const body = await response.text().catch(() => "");
            this.logger?.error("ValiqDataClient request failed", {
                path,
                status: response.status,
                body: body.slice(0, 500),
            });
            throw new Error(`Val-iQ Data API error: ${response.status} ${response.statusText}`);
        }
        const result = (await response.json());
        this.logger?.debug("ValiqDataClient response ok", { path });
        return result;
    }
}
export function createStaticTokenProvider(token) {
    return async () => token;
}
export function createOAuthTokenProvider(config) {
    let cachedToken = null;
    let expiresAt = 0;
    return async () => {
        const now = Date.now();
        if (cachedToken && now < expiresAt) {
            return cachedToken;
        }
        config.logger?.debug("ValiqOAuth acquiring token", { authUrl: config.authUrl });
        const response = await fetch(`${config.authUrl}/oauth/token`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                client_id: config.clientId,
                client_secret: config.clientSecret,
                grant_type: "client_credentials",
                uuid: config.userUuid,
            }),
            signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            const errorCode = body.error ?? "unknown";
            const errorDesc = body.error_description ?? `HTTP ${response.status}`;
            config.logger?.error("ValiqOAuth token acquisition failed", {
                error: errorCode,
                description: errorDesc,
            });
            throw new Error(`Val-iQ OAuth error: ${errorCode} - ${errorDesc}`);
        }
        const data = await response.json();
        cachedToken = data.access_token;
        expiresAt = now + (data.expires_in - 30) * 1000;
        config.logger?.debug("ValiqOAuth token acquired", {
            expiresIn: data.expires_in,
        });
        return cachedToken;
    };
}

"use node";
import { action } from "./_generated/server";
import { v } from "convex/values";
import { requireUser } from "./lib/authGuards";
import { ALPACA_RUNTIME_SECRET_KEYS, AlpacaClient, AlpacaOptionsVenueAdapter, resolveAlpacaRuntimeConfig, } from "@valiq-trading/alpaca-options";
import { BINANCE_RUNTIME_SECRET_KEYS, BinanceClient, BinanceVenueAdapter, resolveBinanceCredentials, } from "@valiq-trading/binance";
import { MT5_RUNTIME_SECRET_KEYS, MT5Client, MT5VenueAdapter, resolveMT5RuntimeConfig, } from "@valiq-trading/mt5";
import { POLYMARKET_RUNTIME_SECRET_KEYS, PolymarketClient, PolymarketVenueAdapter, resolvePolymarketCredentials, } from "@valiq-trading/polymarket";
function env(key) {
    return process.env[key]?.trim() || null;
}
function getSecrets(keys) {
    const secrets = {};
    for (const key of keys) {
        secrets[key] = env(key);
    }
    return secrets;
}
function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
async function fetchJson(url, init, timeoutMs = 15_000) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(url, { ...init, signal: controller.signal });
        clearTimeout(timeoutId);
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            return { ok: false, status: res.status, error: `HTTP ${res.status}: ${body.slice(0, 500)}` };
        }
        const data = await res.json();
        return { ok: true, status: res.status, data };
    }
    catch (error) {
        return { ok: false, status: 0, error: getErrorMessage(error) };
    }
}
export const testBackendHealth = action({
    args: {},
    handler: async (ctx) => {
        await requireUser(ctx);
        const url = env("BACKEND_HEALTH_URL");
        if (!url) {
            return { ok: false, error: "BACKEND_HEALTH_URL not configured in Convex environment variables", steps: [] };
        }
        const result = await fetchJson(url);
        if (!result.ok) {
            return { ok: false, steps: [{ name: "Health", ok: false, error: result.error }] };
        }
        return { ok: true, steps: [{ name: "Health", ok: true, data: result.data }] };
    },
});
export const testMT5Connection = action({
    args: {},
    handler: async (ctx) => {
        await requireUser(ctx);
        const steps = [];
        let runtimeConfig;
        try {
            runtimeConfig = resolveMT5RuntimeConfig(getSecrets(MT5_RUNTIME_SECRET_KEYS));
        }
        catch (error) {
            steps.push({
                name: "Runtime Config",
                ok: false,
                error: getErrorMessage(error),
            });
            return { ok: false, steps };
        }
        steps.push({
            name: "Runtime Config",
            ok: true,
            data: {
                workerUrl: runtimeConfig.workerUrl,
                login: runtimeConfig.credentials.login,
                server: runtimeConfig.credentials.server,
            },
        });
        const client = new MT5Client({
            workerUrl: runtimeConfig.workerUrl,
            accessKey: runtimeConfig.accessKey,
        });
        try {
            const health = await client.getHealth();
            steps.push({ name: "Worker Health", ok: true, data: health });
        }
        catch (error) {
            steps.push({ name: "Worker Health", ok: false, error: getErrorMessage(error) });
            return { ok: false, steps };
        }
        const venue = new MT5VenueAdapter(client, runtimeConfig.credentials);
        try {
            const accountState = await venue.getAccountState();
            steps.push({ name: "Account", ok: true, data: accountState });
        }
        catch (error) {
            steps.push({ name: "Account", ok: false, error: getErrorMessage(error) });
            return { ok: false, steps };
        }
        try {
            const positions = await venue.getPositions();
            steps.push({
                name: "Positions",
                ok: true,
                data: {
                    count: positions.length,
                    positions,
                },
            });
        }
        catch (error) {
            steps.push({ name: "Positions", ok: false, error: getErrorMessage(error) });
            return { ok: false, steps };
        }
        try {
            const workingOrders = await venue.getWorkingOrders();
            steps.push({
                name: "Working Orders",
                ok: true,
                data: {
                    count: workingOrders.length,
                    orders: workingOrders,
                },
            });
        }
        catch (error) {
            steps.push({ name: "Working Orders", ok: false, error: getErrorMessage(error) });
        }
        return { ok: steps.every((step) => step.ok), steps };
    },
});
export const testAlpacaConnection = action({
    args: {},
    handler: async (ctx) => {
        await requireUser(ctx);
        const steps = [];
        let runtimeConfig;
        try {
            runtimeConfig = resolveAlpacaRuntimeConfig(getSecrets(ALPACA_RUNTIME_SECRET_KEYS));
        }
        catch (error) {
            steps.push({
                name: "Runtime Config",
                ok: false,
                error: getErrorMessage(error),
            });
            return { ok: false, steps };
        }
        steps.push({
            name: "Runtime Config",
            ok: true,
            data: {
                environment: runtimeConfig.environment,
                tradingBaseUrl: runtimeConfig.tradingBaseUrl,
                marketDataBaseUrl: runtimeConfig.marketDataBaseUrl,
                accountId: runtimeConfig.credentials.accountId || null,
            },
        });
        const client = new AlpacaClient(runtimeConfig);
        const venue = new AlpacaOptionsVenueAdapter(client);
        try {
            const accountState = await venue.getAccountState();
            steps.push({ name: "Account", ok: true, data: accountState });
        }
        catch (error) {
            steps.push({ name: "Account", ok: false, error: getErrorMessage(error) });
            return { ok: false, steps };
        }
        try {
            const positions = await venue.getPositions();
            steps.push({
                name: "Positions",
                ok: true,
                data: {
                    count: positions.length,
                    positions,
                },
            });
        }
        catch (error) {
            steps.push({ name: "Positions", ok: false, error: getErrorMessage(error) });
            return { ok: false, steps };
        }
        try {
            const contracts = await venue.getOptionContracts({
                underlyingSymbol: "SPY",
                limit: 1,
            });
            steps.push({
                name: "Options Contracts",
                ok: true,
                data: {
                    underlyingSymbol: "SPY",
                    contractCount: contracts.contracts.length,
                    nextPageToken: contracts.nextPageToken,
                },
            });
        }
        catch (error) {
            steps.push({ name: "Options Contracts", ok: false, error: getErrorMessage(error) });
            return { ok: false, steps };
        }
        try {
            const quote = await venue.getQuote("SPY");
            steps.push({
                name: "Market Data",
                ok: true,
                data: {
                    symbol: "SPY",
                    quote,
                },
            });
        }
        catch (error) {
            steps.push({ name: "Market Data", ok: false, error: getErrorMessage(error) });
        }
        return { ok: steps.every((step) => step.ok), steps };
    },
});
export const testPolymarketConnection = action({
    args: {},
    handler: async (ctx) => {
        await requireUser(ctx);
        const steps = [];
        let credentials;
        try {
            credentials = resolvePolymarketCredentials(getSecrets(POLYMARKET_RUNTIME_SECRET_KEYS));
        }
        catch (error) {
            steps.push({
                name: "Runtime Config",
                ok: false,
                error: getErrorMessage(error),
            });
            return { ok: false, steps };
        }
        const client = new PolymarketClient(credentials);
        const venue = new PolymarketVenueAdapter(client);
        steps.push({
            name: "Runtime Config",
            ok: true,
            data: {
                signerAddress: client.getAddress(),
                funderAddress: client.getFunderAddress(),
                signatureType: client.getSignatureType(),
                host: credentials.host ?? null,
                chainId: credentials.chainId ?? null,
                orderOwner: "Orders will be created with POLYMARKET_FUNDER_ADDRESS as maker or owner",
            },
        });
        try {
            const markets = await client.getMarkets({ limit: 1, active: true });
            steps.push({
                name: "Public API",
                ok: true,
                data: {
                    reachable: true,
                    marketsReturned: markets.data.length,
                },
            });
        }
        catch (error) {
            steps.push({ name: "Public API", ok: false, error: getErrorMessage(error) });
            return { ok: false, steps };
        }
        try {
            const [balance, openOrders] = await Promise.all([
                client.getBalance(),
                client.getOpenOrders(),
            ]);
            steps.push({
                name: "Authenticated Runtime Path",
                ok: true,
                data: {
                    balance,
                    openOrderCount: openOrders.length,
                    note: "Matches the backend plugin startup validation path",
                },
            });
        }
        catch (error) {
            steps.push({
                name: "Authenticated Runtime Path",
                ok: false,
                error: getErrorMessage(error),
            });
            return { ok: false, steps };
        }
        try {
            const accountState = await venue.getAccountState();
            steps.push({ name: "Account", ok: true, data: accountState });
        }
        catch (error) {
            steps.push({ name: "Account", ok: false, error: getErrorMessage(error) });
            return { ok: false, steps };
        }
        try {
            const positions = await venue.getPositions();
            steps.push({
                name: "Positions",
                ok: true,
                data: {
                    count: positions.length,
                    positions,
                },
            });
        }
        catch (error) {
            steps.push({ name: "Positions", ok: false, error: getErrorMessage(error) });
            return { ok: false, steps };
        }
        try {
            const workingOrders = await venue.getWorkingOrders();
            steps.push({
                name: "Open Bets",
                ok: true,
                data: {
                    count: workingOrders.length,
                    orders: workingOrders,
                },
            });
        }
        catch (error) {
            steps.push({ name: "Open Bets", ok: false, error: getErrorMessage(error) });
        }
        return { ok: steps.every((step) => step.ok), steps };
    },
});
export const testBinanceConnection = action({
    args: {},
    handler: async (ctx) => {
        await requireUser(ctx);
        const steps = [];
        let credentials;
        try {
            credentials = resolveBinanceCredentials(getSecrets(BINANCE_RUNTIME_SECRET_KEYS));
        }
        catch (error) {
            steps.push({
                name: "Runtime Config",
                ok: false,
                error: getErrorMessage(error),
            });
            return { ok: false, steps };
        }
        steps.push({
            name: "Runtime Config",
            ok: true,
            data: {
                baseUrl: credentials.baseUrl ?? null,
            },
        });
        const client = new BinanceClient(credentials);
        const venue = new BinanceVenueAdapter(client);
        try {
            await client.ping();
            steps.push({ name: "Public API", ok: true, data: { reachable: true } });
        }
        catch (error) {
            steps.push({ name: "Public API", ok: false, error: getErrorMessage(error) });
            return { ok: false, steps };
        }
        try {
            const accountState = await venue.getAccountState();
            steps.push({ name: "Account", ok: true, data: accountState });
        }
        catch (error) {
            steps.push({ name: "Account", ok: false, error: getErrorMessage(error) });
            return { ok: false, steps };
        }
        try {
            const positions = await venue.getPositions();
            steps.push({
                name: "Positions",
                ok: true,
                data: {
                    count: positions.length,
                    positions,
                },
            });
        }
        catch (error) {
            steps.push({ name: "Positions", ok: false, error: getErrorMessage(error) });
            return { ok: false, steps };
        }
        try {
            const marketPrice = await venue.getMarketPrice("BTCUSDT");
            steps.push({ name: "Market Data", ok: true, data: marketPrice });
        }
        catch (error) {
            steps.push({ name: "Market Data", ok: false, error: getErrorMessage(error) });
        }
        return { ok: steps.every((step) => step.ok), steps };
    },
});
async function acquireValiqToken(authUrl, clientId, clientSecret, userUuid) {
    try {
        const res = await fetch(`${authUrl}/oauth/token`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                client_id: clientId,
                client_secret: clientSecret,
                grant_type: "client_credentials",
                uuid: userUuid,
            }),
            signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            const errorCode = body.error ?? "unknown";
            const descriptions = {
                invalid_client: "Organization not found, inactive, or invalid secret",
                invalid_grant: "User not found, inactive, or does not belong to organization",
                invalid_request: "Missing or invalid request fields",
                server_error: "Val-iQ auth server error",
            };
            const errorDesc = body.error_description ?? descriptions[errorCode] ?? `HTTP ${res.status}`;
            return { ok: false, error: errorDesc, errorCode };
        }
        const data = await res.json();
        return { ok: true, token: data.access_token, expiresIn: data.expires_in };
    }
    catch (error) {
        return { ok: false, error: getErrorMessage(error) };
    }
}
export const testValiqConnection = action({
    args: {
        prompt: v.string(),
    },
    handler: async (ctx, args) => {
        await requireUser(ctx);
        const apiUrl = env("VALIQ_API_URL")?.replace(/\/+$/, "");
        const authUrl = env("VALIQ_AUTH_URL")?.replace(/\/+$/, "");
        const clientId = env("VALIQ_OAUTH_CLIENT_ID");
        const clientSecret = env("VALIQ_OAUTH_CLIENT_SECRET");
        const userUuid = env("VALIQ_OAUTH_USER_UUID");
        if (!apiUrl) {
            return { ok: false, error: "VALIQ_API_URL not configured in Convex environment variables", steps: [] };
        }
        if (!authUrl || !clientId || !clientSecret || !userUuid) {
            return {
                ok: false,
                error: "Val-iQ OAuth credentials not configured (VALIQ_AUTH_URL, VALIQ_OAUTH_CLIENT_ID, VALIQ_OAUTH_CLIENT_SECRET, VALIQ_OAUTH_USER_UUID)",
                steps: [],
            };
        }
        const steps = [];
        const authResult = await acquireValiqToken(authUrl, clientId, clientSecret, userUuid);
        if (!authResult.ok || !authResult.token) {
            steps.push({ name: "Auth", ok: false, error: authResult.error });
            return { ok: false, steps };
        }
        steps.push({ name: "Auth", ok: true, data: { expiresIn: authResult.expiresIn } });
        const authToken = authResult.token;
        const headers = {
            Authorization: `Bearer ${authToken}`,
            "Content-Type": "application/json",
        };
        const chat = await fetchJson(`${apiUrl}/chats`, {
            method: "POST",
            headers,
            body: JSON.stringify({ title: "Connection Test" }),
        });
        if (!chat.ok) {
            steps.push({ name: "Create Chat", ok: false, error: chat.error });
            return { ok: false, steps };
        }
        const chatId = chat.data.id;
        steps.push({ name: "Create Chat", ok: true, data: { chatId } });
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 120_000);
            const res = await fetch(`${apiUrl}/chats/${chatId}/messages`, {
                method: "POST",
                headers: { ...headers, Accept: "text/event-stream" },
                body: JSON.stringify({ content: args.prompt }),
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            if (!res.ok) {
                const body = await res.text().catch(() => "");
                steps.push({
                    name: "Send Prompt",
                    ok: false,
                    error: `HTTP ${res.status}: ${body.slice(0, 500)}`,
                });
                return { ok: false, steps };
            }
            const text = await res.text();
            const lines = text
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean);
            const dataLines = lines
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trim())
                .filter((line) => line && line !== "[DONE]");
            steps.push({
                name: "Send Prompt",
                ok: dataLines.length > 0,
                data: {
                    prompt: args.prompt,
                    events: dataLines.slice(0, 5),
                    totalEvents: dataLines.length,
                },
                error: dataLines.length > 0 ? undefined : "No SSE data events received",
            });
        }
        catch (error) {
            steps.push({ name: "Send Prompt", ok: false, error: getErrorMessage(error) });
        }
        return { ok: steps.every((s) => s.ok), steps };
    },
});

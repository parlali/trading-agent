"use node"

import { action } from "./_generated/server"
import { v } from "convex/values"
import { createHmac } from "crypto"

function env(key: string): string | null {
    return process.env[key]?.trim() || null
}

async function fetchJson(
    url: string,
    init?: RequestInit,
    timeoutMs = 15_000
): Promise<{ ok: boolean; status: number; data?: unknown; error?: string }> {
    try {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

        const res = await fetch(url, { ...init, signal: controller.signal })
        clearTimeout(timeoutId)

        if (!res.ok) {
            const body = await res.text().catch(() => "")
            return { ok: false, status: res.status, error: `HTTP ${res.status}: ${body.slice(0, 500)}` }
        }

        const data = await res.json()
        return { ok: true, status: res.status, data }
    } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e)
        return { ok: false, status: 0, error: message }
    }
}

export const testBackendHealth = action({
    args: {},
    handler: async () => {
        const url = env("BACKEND_HEALTH_URL")
        if (!url) {
            return { ok: false, error: "BACKEND_HEALTH_URL not configured in Convex environment variables", steps: [] }
        }

        const result = await fetchJson(url)
        if (!result.ok) {
            return { ok: false, steps: [{ name: "Health", ok: false, error: result.error }] }
        }

        return { ok: true, steps: [{ name: "Health", ok: true, data: result.data }] }
    },
})

export const testMT5Connection = action({
    args: {},
    handler: async () => {
        const workerUrl = env("MT5_WORKER_URL")?.replace(/\/$/, "")
        const accessKey = env("MT5_WORKER_ACCESS_KEY")

        if (!workerUrl) {
            return { ok: false, error: "MT5_WORKER_URL not configured", steps: [] }
        }

        const steps: Array<{ name: string; ok: boolean; data?: unknown; error?: string }> = []
        const headers: Record<string, string> = { "Content-Type": "application/json" }
        if (accessKey) headers["x-worker-key"] = accessKey

        const health = await fetchJson(`${workerUrl}/health`, { headers })
        if (!health.ok) {
            steps.push({ name: "Worker Health", ok: false, error: health.error })
            return { ok: false, steps }
        }
        steps.push({ name: "Worker Health", ok: true, data: health.data })

        const login = env("MT5_PRIMARY_LOGIN")
        const password = env("MT5_PRIMARY_PASSWORD")
        const server = env("MT5_PRIMARY_SERVER")

        if (!login || !password || !server) {
            steps.push({
                name: "Connect",
                ok: false,
                error: "MT5 trading credentials not configured (MT5_PRIMARY_LOGIN, MT5_PRIMARY_PASSWORD, MT5_PRIMARY_SERVER)",
            })
            return { ok: false, steps }
        }

        const connect = await fetchJson(`${workerUrl}/connect`, {
            method: "POST",
            headers,
            body: JSON.stringify({ login: Number(login), password, server }),
        })
        if (!connect.ok) {
            steps.push({ name: "Connect", ok: false, error: connect.error })
            return { ok: false, steps }
        }
        const connectData = connect.data as { success: boolean; accountInfo?: unknown; error?: string }
        if (!connectData.success) {
            steps.push({ name: "Connect", ok: false, error: connectData.error ?? "Connection failed" })
            return { ok: false, steps }
        }
        steps.push({ name: "Connect", ok: true, data: connectData.accountInfo })

        const positions = await fetchJson(`${workerUrl}/positions`, { headers })
        steps.push({
            name: "Positions",
            ok: positions.ok,
            data: positions.data,
            error: positions.ok ? undefined : positions.error,
        })

        return { ok: steps.every((s) => s.ok), steps }
    },
})

export const testAlpacaConnection = action({
    args: {},
    handler: async () => {
        const apiKey = env("ALPACA_PRIMARY_API_KEY") ?? env("ALPACA_API_KEY")
        const secretKey = env("ALPACA_PRIMARY_SECRET_KEY") ?? env("ALPACA_SECRET_KEY")
        const rawBaseUrl = env("ALPACA_BASE_URL") ?? "https://paper-api.alpaca.markets"
        const baseUrl = rawBaseUrl.replace(/\/+$/, "").replace(/\/v2$/, "")
        const accountId = env("ALPACA_ACCOUNT_ID")

        if (!apiKey || !secretKey) {
            return {
                ok: false,
                error: "Alpaca API credentials not configured (ALPACA_PRIMARY_API_KEY, ALPACA_PRIMARY_SECRET_KEY)",
                steps: [],
            }
        }

        const steps: Array<{ name: string; ok: boolean; data?: unknown; error?: string }> = []
        const headers: Record<string, string> = {
            "APCA-API-KEY-ID": apiKey,
            "APCA-API-SECRET-KEY": secretKey,
            "Content-Type": "application/json",
        }
        if (accountId) headers["APCA-ACCOUNT-ID"] = accountId

        const account = await fetchJson(`${baseUrl}/v2/account`, { headers })
        if (!account.ok) {
            steps.push({ name: "Account", ok: false, error: account.error })
            return { ok: false, steps }
        }
        steps.push({ name: "Account", ok: true, data: account.data })

        const positions = await fetchJson(`${baseUrl}/v2/positions`, { headers })
        steps.push({
            name: "Positions",
            ok: positions.ok,
            data: positions.data,
            error: positions.ok ? undefined : positions.error,
        })

        const allPositions = (positions.data ?? []) as Array<{ asset_class?: string }>
        const optionsOnly = allPositions.filter((p) => p.asset_class === "us_option")
        steps.push({
            name: "Options Positions",
            ok: true,
            data: optionsOnly,
        })

        return { ok: steps.every((s) => s.ok), steps }
    },
})

export const testPolymarketConnection = action({
    args: {},
    handler: async () => {
        const privateKey = env("POLYMARKET_PRIVATE_KEY")
        const apiKey = env("POLYMARKET_API_KEY")
        const apiSecret = env("POLYMARKET_API_SECRET")
        const apiPassphrase = env("POLYMARKET_API_PASSPHRASE")
        const host = (env("POLYMARKET_HOST") ?? "https://clob.polymarket.com").replace(/\/+$/, "")

        const steps: Array<{ name: string; ok: boolean; data?: unknown; error?: string }> = []

        const markets = await fetchJson(`${host}/markets?limit=1`)
        if (!markets.ok) {
            steps.push({ name: "Public API", ok: false, error: markets.error })
            return { ok: false, steps }
        }
        const marketsData = markets.data as { data?: unknown[] } | undefined
        steps.push({
            name: "Public API",
            ok: true,
            data: { reachable: true, marketsReturned: Array.isArray(marketsData?.data) ? marketsData.data.length : 0 },
        })

        if (!privateKey || !apiKey || !apiSecret || !apiPassphrase) {
            steps.push({
                name: "Balance",
                ok: false,
                error: "Polymarket credentials not fully configured (POLYMARKET_PRIVATE_KEY, POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_API_PASSPHRASE)",
            })
            return { ok: false, steps }
        }

        let address: string
        try {
            const { privateKeyToAccount } = await import("viem/accounts")
            const pk = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as `0x${string}`
            address = privateKeyToAccount(pk).address
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e)
            steps.push({ name: "Balance", ok: false, error: `Failed to derive wallet address: ${message}` })
            return { ok: false, steps }
        }

        const method = "GET"
        const path = "/balance-allowance"
        const timestamp = Math.floor(Date.now() / 1000).toString()
        const message = timestamp + method + path
        const normalizedSecret = apiSecret.replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/=]/g, "")
        const hmacKey = Buffer.from(normalizedSecret, "base64")
        const signature = createHmac("sha256", hmacKey)
            .update(message)
            .digest("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")

        const authHeaders: Record<string, string> = {
            "Content-Type": "application/json",
            POLY_ADDRESS: address,
            POLY_SIGNATURE: signature,
            POLY_TIMESTAMP: timestamp,
            POLY_API_KEY: apiKey,
            POLY_PASSPHRASE: apiPassphrase,
        }

        const USDC_DECIMALS = 1_000_000

        const balanceEoa = await fetchJson(
            `${host}${path}?asset_type=COLLATERAL&signature_type=0`,
            { headers: authHeaders }
        )
        if (!balanceEoa.ok) {
            steps.push({ name: "Balance", ok: false, error: balanceEoa.error })
            return { ok: false, steps }
        }
        const eoaData = balanceEoa.data as { balance?: string; allowances?: Record<string, string> } | undefined
        const eoaRaw = Number(eoaData?.balance ?? "0")
        steps.push({ name: "Balance (EOA, type=0)", ok: true, data: { ...eoaData, balanceUsd: eoaRaw / USDC_DECIMALS } })

        const balanceProxy = await fetchJson(
            `${host}${path}?asset_type=COLLATERAL&signature_type=1`,
            { headers: authHeaders }
        )
        if (balanceProxy.ok) {
            const proxyData = balanceProxy.data as { balance?: string; allowances?: Record<string, string> } | undefined
            const proxyRaw = Number(proxyData?.balance ?? "0")
            steps.push({ name: "Balance (Proxy, type=1)", ok: true, data: { ...proxyData, balanceUsd: proxyRaw / USDC_DECIMALS } })
        }

        return { ok: steps.every((s) => s.ok), steps }
    },
})

async function acquireValiqToken(
    authUrl: string,
    clientId: string,
    clientSecret: string,
    userUuid: string
): Promise<{ ok: boolean; token?: string; expiresIn?: number; error?: string; errorCode?: string }> {
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
        })

        if (!res.ok) {
            const body = await res.json().catch(() => ({})) as {
                error?: string
                error_description?: string
            }
            const errorCode = body.error ?? "unknown"
            const descriptions: Record<string, string> = {
                invalid_client: "Organization not found, inactive, or invalid secret",
                invalid_grant: "User not found, inactive, or does not belong to organization",
                invalid_request: "Missing or invalid request fields",
                server_error: "Val-iQ auth server error",
            }
            const errorDesc = body.error_description ?? descriptions[errorCode] ?? `HTTP ${res.status}`
            return { ok: false, error: errorDesc, errorCode }
        }

        const data = await res.json() as { access_token: string; token_type: string; expires_in: number }
        return { ok: true, token: data.access_token, expiresIn: data.expires_in }
    } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e)
        return { ok: false, error: message }
    }
}

export const testValiqConnection = action({
    args: {
        prompt: v.string(),
    },
    handler: async (_ctx, args) => {
        const apiUrl = env("VALIQ_API_URL")?.replace(/\/+$/, "")
        const authUrl = env("VALIQ_AUTH_URL")?.replace(/\/+$/, "")
        const clientId = env("VALIQ_OAUTH_CLIENT_ID")
        const clientSecret = env("VALIQ_OAUTH_CLIENT_SECRET")
        const userUuid = env("VALIQ_OAUTH_USER_UUID")

        if (!apiUrl) {
            return { ok: false, error: "VALIQ_API_URL not configured in Convex environment variables", steps: [] }
        }

        if (!authUrl || !clientId || !clientSecret || !userUuid) {
            return {
                ok: false,
                error: "Val-iQ OAuth credentials not configured (VALIQ_AUTH_URL, VALIQ_OAUTH_CLIENT_ID, VALIQ_OAUTH_CLIENT_SECRET, VALIQ_OAUTH_USER_UUID)",
                steps: [],
            }
        }

        const steps: Array<{ name: string; ok: boolean; data?: unknown; error?: string }> = []

        const authResult = await acquireValiqToken(authUrl, clientId, clientSecret, userUuid)
        if (!authResult.ok || !authResult.token) {
            steps.push({ name: "Auth", ok: false, error: authResult.error })
            return { ok: false, steps }
        }
        steps.push({ name: "Auth", ok: true, data: { expiresIn: authResult.expiresIn } })

        const authToken = authResult.token
        const headers: Record<string, string> = {
            Authorization: `Bearer ${authToken}`,
            "Content-Type": "application/json",
        }

        const chat = await fetchJson(`${apiUrl}/chats`, {
            method: "POST",
            headers,
            body: JSON.stringify({ title: "Connection Test" }),
        })
        if (!chat.ok) {
            steps.push({ name: "Create Chat", ok: false, error: chat.error })
            return { ok: false, steps }
        }
        const chatId = (chat.data as { id: string }).id
        steps.push({ name: "Create Chat", ok: true, data: { chatId } })

        try {
            const controller = new AbortController()
            const timeoutId = setTimeout(() => controller.abort(), 120_000)

            const res = await fetch(`${apiUrl}/chats/${chatId}/messages`, {
                method: "POST",
                headers: { ...headers, Accept: "text/event-stream" },
                body: JSON.stringify({ content: args.prompt }),
                signal: controller.signal,
            })
            clearTimeout(timeoutId)

            if (!res.ok) {
                const text = await res.text().catch(() => "")
                steps.push({ name: "Research", ok: false, error: `HTTP ${res.status}: ${text.slice(0, 500)}` })
                return { ok: false, steps }
            }

            if (!res.body) {
                steps.push({ name: "Research", ok: false, error: "No response body" })
                return { ok: false, steps }
            }

            const reader = res.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ""
            let finalContent = ""

            // eslint-disable-next-line no-constant-condition
            while (true) {
                const { done, value } = await reader.read()
                if (done) break

                buffer += decoder.decode(value, { stream: true })
                const lines = buffer.split("\n")
                buffer = lines.pop() ?? ""

                for (const line of lines) {
                    const trimmed = line.trim()
                    if (!trimmed.startsWith("data: ") || trimmed === "data: [DONE]") continue

                    try {
                        const event = JSON.parse(trimmed.slice(6)) as {
                            type: string
                            data?: { content?: string; finalContent?: string; message?: string }
                        }
                        if (event.type === "final_response") {
                            finalContent += event.data?.content ?? ""
                        } else if (event.type === "completion" && event.data?.finalContent) {
                            finalContent = event.data.finalContent
                        } else if (event.type === "error") {
                            steps.push({ name: "Research", ok: false, error: event.data?.message ?? "Unknown SSE error" })
                            return { ok: false, steps }
                        }
                    } catch {
                        // skip malformed events
                    }
                }
            }

            steps.push({
                name: "Research",
                ok: true,
                data: { contentLength: finalContent.length, preview: finalContent.slice(0, 2000) },
            })
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e)
            steps.push({ name: "Research", ok: false, error: message })
            return { ok: false, steps }
        }

        try {
            await fetch(`${apiUrl}/chats/${chatId}`, { method: "DELETE", headers })
            steps.push({ name: "Cleanup", ok: true })
        } catch {
            steps.push({ name: "Cleanup", ok: false, error: "Failed to clean up chat" })
        }

        return { ok: steps.every((s) => s.ok), steps }
    },
})

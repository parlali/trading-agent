import { beforeEach, describe, expect, it, vi } from "vitest"
import { FiveSocketClient } from "./fivesocket-client.ts"
import {
    createMT5Client,
    resetMT5ClientPoolForTests,
    resolveMT5RuntimeConfig,
} from "./runtime-config.ts"

const baseSecrets = {
    FIVESOCKET_API_BASE_URL: null,
    FIVESOCKET_API_KEY: "fs-key",
    FIVESOCKET_DEFAULT_MAX_VOLUME: "1.0",
    MT5_PRIMARY_LOGIN: "111",
    MT5_PRIMARY_PASSWORD: "secret",
    MT5_PRIMARY_SERVER: "broker",
}

describe("MT5 runtime config", () => {
    beforeEach(() => {
        resetMT5ClientPoolForTests()
    })

    it("resolves FiveSocket runtime config and client", () => {
        const runtime = resolveMT5RuntimeConfig(baseSecrets, {})

        expect(runtime).toEqual({
            baseUrl: "https://api.fivesocket.com",
            apiKey: "fs-key",
            defaultMaxVolume: "1.0",
            credentialEnvPrefix: "MT5_PRIMARY",
            credentials: {
                login: 111,
                password: "secret",
                server: "broker",
            },
        })
        expect("transport" in runtime).toBe(false)
        expect(createMT5Client(runtime)).toBeInstanceOf(FiveSocketClient)
    })

    it("resolves account credentials from the requested MT5 credential prefix", () => {
        const runtime = resolveMT5RuntimeConfig({
            FIVESOCKET_API_BASE_URL: null,
            FIVESOCKET_API_KEY: "fs-key",
            FIVESOCKET_DEFAULT_MAX_VOLUME: "1.0",
            MT5_PRIMARY_LOGIN: "111",
            MT5_PRIMARY_PASSWORD: "primary-secret",
            MT5_PRIMARY_SERVER: "primary-broker",
            MT5_SECONDARY_LOGIN: "222",
            MT5_SECONDARY_PASSWORD: "secondary-secret",
            MT5_SECONDARY_SERVER: "secondary-broker",
        }, {}, "MT5_SECONDARY")

        expect(runtime.credentials).toEqual({
            login: 222,
            password: "secondary-secret",
            server: "secondary-broker",
        })
    })

    it("pools clients by credential prefix and resolved account identity", () => {
        const primary = resolveMT5RuntimeConfig({
            FIVESOCKET_API_BASE_URL: null,
            FIVESOCKET_API_KEY: "fs-key",
            FIVESOCKET_DEFAULT_MAX_VOLUME: "1.0",
            MT5_PRIMARY_LOGIN: "111",
            MT5_PRIMARY_PASSWORD: "primary-secret",
            MT5_PRIMARY_SERVER: "primary-broker",
            MT5_SECONDARY_LOGIN: "222",
            MT5_SECONDARY_PASSWORD: "secondary-secret",
            MT5_SECONDARY_SERVER: "secondary-broker",
        }, {}, "MT5_PRIMARY")
        const secondary = resolveMT5RuntimeConfig({
            FIVESOCKET_API_BASE_URL: null,
            FIVESOCKET_API_KEY: "fs-key",
            FIVESOCKET_DEFAULT_MAX_VOLUME: "1.0",
            MT5_PRIMARY_LOGIN: "111",
            MT5_PRIMARY_PASSWORD: "primary-secret",
            MT5_PRIMARY_SERVER: "primary-broker",
            MT5_SECONDARY_LOGIN: "222",
            MT5_SECONDARY_PASSWORD: "secondary-secret",
            MT5_SECONDARY_SERVER: "secondary-broker",
        }, {}, "MT5_SECONDARY")

        const firstPrimary = createMT5Client(primary, {
            executionSymbols: [{ symbol: "XAUUSD", maxVolume: "1.0" }],
        })
        const secondPrimary = createMT5Client(primary, {
            executionSymbols: [{ symbol: "XAUUSD", maxVolume: "1.0" }],
        })
        const secondaryClient = createMT5Client(secondary, {
            executionSymbols: [{ symbol: "XAUUSD", maxVolume: "1.0" }],
        })

        expect(secondPrimary).toBe(firstPrimary)
        expect(secondaryClient).not.toBe(firstPrimary)
    })

    it("updates a pooled execution symbol set without creating another client or repeating unchanged policy PUTs", async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
        const runtime = resolveMT5RuntimeConfig(baseSecrets, {})
        const transport = createPooledTransport()

        try {
            const first = createMT5Client(runtime, {
                executionSymbols: [{ symbol: " XAUUSD ", maxVolume: "1.0" }],
                minRequestIntervalMs: 0,
                fetchImpl: transport.fetchImpl,
            })
            await first.connect(runtime.credentials)

            for (let attempt = 0; attempt < 4; attempt += 1) {
                const pooled = createMT5Client(runtime, {
                    executionSymbols: [{ symbol: "XAUUSD", maxVolume: "1.0" }],
                    minRequestIntervalMs: 0,
                    fetchImpl: transport.fetchImpl,
                })
                expect(pooled).toBe(first)
                await pooled.connect(runtime.credentials)
            }

            expect(transport.putBodies()).toEqual([
                { symbols: [{ symbol: "XAUUSD", maxVolume: "1.0" }] },
            ])

            const changed = createMT5Client(runtime, {
                executionSymbols: [
                    { symbol: "EURUSD", maxVolume: "1.0" },
                    { symbol: "XAUUSD", maxVolume: "1.0" },
                ],
                minRequestIntervalMs: 0,
                fetchImpl: transport.fetchImpl,
            })
            expect(changed).toBe(first)
            await changed.connect(runtime.credentials)

            const reorderedSameSet = createMT5Client(runtime, {
                executionSymbols: [
                    { symbol: "XAUUSD", maxVolume: "1.0" },
                    { symbol: "EURUSD", maxVolume: "1.0" },
                ],
                minRequestIntervalMs: 0,
                fetchImpl: transport.fetchImpl,
            })
            expect(reorderedSameSet).toBe(first)
            await reorderedSameSet.connect(runtime.credentials)

            expect(transport.putBodies()).toEqual([
                { symbols: [{ symbol: "XAUUSD", maxVolume: "1.0" }] },
                {
                    symbols: [
                        { symbol: "EURUSD", maxVolume: "1.0" },
                        { symbol: "XAUUSD", maxVolume: "1.0" },
                    ],
                },
            ])
            expect(warnSpy).toHaveBeenCalledTimes(1)
        } finally {
            warnSpy.mockRestore()
        }
    })

    it("fails closed with the requested MT5 credential prefix when account credentials are missing", () => {
        expect(() =>
            resolveMT5RuntimeConfig({
                FIVESOCKET_API_BASE_URL: null,
                FIVESOCKET_API_KEY: "fs-key",
                FIVESOCKET_DEFAULT_MAX_VOLUME: "1.0",
                MT5_SECONDARY_PASSWORD: "secondary-secret",
                MT5_SECONDARY_SERVER: "secondary-broker",
            }, {}, "MT5_SECONDARY")
        ).toThrow("Missing required secret: MT5_SECONDARY_LOGIN")
    })

    it("resolves canonically re-keyed account secrets from the scheduler pipeline for any prefix", () => {
        const runtime = resolveMT5RuntimeConfig({
            FIVESOCKET_API_BASE_URL: null,
            FIVESOCKET_API_KEY: "fs-key",
            FIVESOCKET_DEFAULT_MAX_VOLUME: "1.0",
            MT5_LOGIN: "333",
            MT5_PASSWORD: "tertiary-secret",
            MT5_SERVER: "tertiary-broker",
        }, {}, "MT5_TERTIARY")

        expect(runtime.credentials).toEqual({
            login: 333,
            password: "tertiary-secret",
            server: "tertiary-broker",
        })
    })

    it("never reads bare canonical credentials from ambient process env", () => {
        expect(() =>
            resolveMT5RuntimeConfig({
                FIVESOCKET_API_BASE_URL: null,
                FIVESOCKET_API_KEY: "fs-key",
                FIVESOCKET_DEFAULT_MAX_VOLUME: "1.0",
            }, {
                MT5_LOGIN: "999",
                MT5_PASSWORD: "ambient-secret",
                MT5_SERVER: "ambient-broker",
            }, "MT5_TERTIARY")
        ).toThrow("Missing required secret: MT5_TERTIARY_LOGIN")
    })

    it("fails closed on an empty credentialEnvPrefix instead of defaulting to an account", () => {
        expect(() =>
            resolveMT5RuntimeConfig({
                FIVESOCKET_API_BASE_URL: null,
                FIVESOCKET_API_KEY: "fs-key",
                FIVESOCKET_DEFAULT_MAX_VOLUME: "1.0",
                MT5_PRIMARY_LOGIN: "111",
                MT5_PRIMARY_PASSWORD: "primary-secret",
                MT5_PRIMARY_SERVER: "primary-broker",
            }, {}, "  ")
        ).toThrow("empty credentialEnvPrefix")
    })

    it("fails closed when FIVESOCKET_API_KEY is missing", () => {
        expect(() =>
            resolveMT5RuntimeConfig({
                ...baseSecrets,
                FIVESOCKET_API_KEY: null,
            }, {})
        ).toThrow("Missing required secret: FIVESOCKET_API_KEY")
    })

    it("fails closed when FIVESOCKET_DEFAULT_MAX_VOLUME is missing", () => {
        expect(() =>
            resolveMT5RuntimeConfig({
                ...baseSecrets,
                FIVESOCKET_DEFAULT_MAX_VOLUME: null,
            }, {})
        ).toThrow("Missing required secret: FIVESOCKET_DEFAULT_MAX_VOLUME")
    })

    it("accepts stale MT5_TRANSPORT=fivesocket", () => {
        const runtime = resolveMT5RuntimeConfig({
            ...baseSecrets,
            MT5_TRANSPORT: "fivesocket",
        }, {})

        expect(runtime.baseUrl).toBe("https://api.fivesocket.com")
    })

    it("rejects stale MT5_TRANSPORT=worker", () => {
        expect(() =>
            resolveMT5RuntimeConfig({
                ...baseSecrets,
                MT5_TRANSPORT: "worker",
            }, {})
        ).toThrow("MT5 worker transport has been removed; unset MT5_TRANSPORT (FiveSocket is the only transport)")
    })
})

function createPooledTransport(): {
    fetchImpl: typeof fetch
    putBodies: () => unknown[]
} {
    const bodies: unknown[] = []

    return {
        putBodies: () => bodies,
        fetchImpl: async (input, init) => {
            const url = String(input)
            const method = init?.method ?? "GET"
            const body = init?.body ? JSON.parse(String(init.body)) : undefined

            if (method === "POST" && url.endsWith("/v1/accounts")) {
                return jsonResponse({
                    id: "acc-1",
                    login: "111",
                    server: "broker",
                    status: "active",
                    createdAt: new Date().toISOString(),
                }, 201)
            }

            if (method === "PUT" && url.endsWith("/execution")) {
                bodies.push(body)
                return jsonResponse({
                    accountId: "acc-1",
                    status: "enabled",
                    symbols: readSymbols(body),
                    updatedAt: new Date().toISOString(),
                })
            }

            if (method === "GET" && url.endsWith("/balance")) {
                return jsonResponse({
                    accountId: "acc-1",
                    login: "111",
                    server: "broker",
                    observedAt: new Date().toISOString(),
                    latencyMs: 1,
                    balance: "1000",
                    equity: "1000",
                    currency: "USD",
                    credit: "0",
                    margin: "0",
                    marginFree: "1000",
                    profit: "0",
                    leverage: "100",
                    name: "Demo",
                    company: "Broker",
                })
            }

            throw new Error(`Unexpected request ${method} ${url}`)
        },
    }
}

function readSymbols(body: unknown): unknown {
    return typeof body === "object" && body !== null && "symbols" in body
        ? (body as { symbols: unknown }).symbols
        : []
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    })
}

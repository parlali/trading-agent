import { describe, expect, it } from "vitest"
import { FiveSocketClient } from "./fivesocket-client.ts"
import {
    createMT5Client,
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
    it("resolves FiveSocket runtime config and client", () => {
        const runtime = resolveMT5RuntimeConfig(baseSecrets, {})

        expect(runtime).toEqual({
            baseUrl: "https://api.fivesocket.com",
            apiKey: "fs-key",
            defaultMaxVolume: "1.0",
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

    it("never falls back to canonical or other-account credentials for a scoped prefix", () => {
        expect(() =>
            resolveMT5RuntimeConfig({
                FIVESOCKET_API_BASE_URL: null,
                FIVESOCKET_API_KEY: "fs-key",
                FIVESOCKET_DEFAULT_MAX_VOLUME: "1.0",
                MT5_LOGIN: "999",
                MT5_PASSWORD: "canonical-secret",
                MT5_SERVER: "canonical-broker",
                MT5_PRIMARY_LOGIN: "111",
                MT5_PRIMARY_PASSWORD: "primary-secret",
                MT5_PRIMARY_SERVER: "primary-broker",
            }, {}, "MT5_TERTIARY")
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

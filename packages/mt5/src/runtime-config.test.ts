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

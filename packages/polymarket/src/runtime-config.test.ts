import { describe, expect, it } from "vitest"
import {
    resolvePolymarketCredentials,
    resolvePolymarketFunderAddress,
} from "./runtime-config"

describe("resolvePolymarketFunderAddress", () => {
    it("rejects missing or invalid explicit funder addresses", () => {
        expect(() => resolvePolymarketFunderAddress({
            POLYMARKET_FUNDER_ADDRESS: null,
            POLYMARKET_PRIVATE_KEY: "0x123",
        })).toThrow("Missing required secret: POLYMARKET_FUNDER_ADDRESS")
        expect(() => resolvePolymarketFunderAddress({
            POLYMARKET_FUNDER_ADDRESS: "not-an-address",
        })).toThrow("POLYMARKET_FUNDER_ADDRESS must be a valid 0x wallet address for the Polymarket profile or proxy wallet")
    })

    it("normalizes a valid wallet address for standalone and credential resolution", () => {
        expect(resolvePolymarketFunderAddress({
            POLYMARKET_FUNDER_ADDRESS: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
        })).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")

        const credentials = resolvePolymarketCredentials({
            POLYMARKET_PRIVATE_KEY: "private-key",
            POLYMARKET_API_KEY: "api-key",
            POLYMARKET_API_SECRET: "api-secret",
            POLYMARKET_API_PASSPHRASE: "api-passphrase",
            POLYMARKET_HOST: "https://clob.polymarket.com",
            POLYMARKET_CHAIN_ID: "137",
            POLYMARKET_FUNDER_ADDRESS: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
        })

        expect(credentials.funderAddress).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")
    })
})

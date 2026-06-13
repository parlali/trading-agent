import { describe, expect, it } from "vitest"
import {
    derivePolymarketSalt,
    fingerprintPolymarketSignedOrder,
    roundToTickSize,
} from "./polymarket-order-signing.ts"

describe("Polymarket deterministic signed-order identity", () => {
    it("derives stable salts and fingerprints normalized signed order payloads", () => {
        const payload = {
            tokenId: "123",
            side: "buy",
            size: 5,
            price: 0.42,
            orderType: "GTC",
            expiration: 0,
        }

        expect(derivePolymarketSalt("vpme01abcdef2345", payload).toString()).toBe(
            derivePolymarketSalt("vpme01abcdef2345", { ...payload }).toString()
        )
        expect(derivePolymarketSalt("vpme01abcdef2345", payload).toString()).not.toBe(
            derivePolymarketSalt("vpme02abcdef2345", payload).toString()
        )

        const left = fingerprintPolymarketSignedOrder({
            salt: "1",
            maker: "0xmaker",
            tokenId: "123",
            side: 0,
        })
        const right = fingerprintPolymarketSignedOrder({
            side: 0,
            tokenId: "123",
            maker: "0xmaker",
            salt: "1",
        })

        expect(left).toBe(right)
        expect(left).toMatch(/^[a-f0-9]{64}$/)
    })

    it("rounds prices to decimal tick sizes without binary float noise", () => {
        expect(roundToTickSize(0.29, "0.01")).toBe(0.29)
        expect(roundToTickSize(0.58, "0.01")).toBe(0.58)
        expect(roundToTickSize(0.5782, "0.01")).toBe(0.58)
        expect(roundToTickSize(0.123456, "1e-4")).toBe(0.1235)
    })
})

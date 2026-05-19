import { describe, expect, it } from "vitest"
import {
    derivePolymarketSalt,
    fingerprintPolymarketSignedOrder,
} from "./polymarket-order-signing.ts"

describe("Polymarket deterministic signed-order identity", () => {
    it("derives stable salts from canonical order identity and normalized payload", () => {
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
    })

    it("fingerprints the exact signed order body independent of key insertion order", () => {
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
})

import { createHash } from "crypto"
import { stableStringify } from "@valiq-trading/core"

export const CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E" as const
export const NEG_RISK_CTF_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a" as const
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const
export const AMOUNT_DECIMALS = 6
export const AMOUNT_MULTIPLIER = 10 ** AMOUNT_DECIMALS

export const ORDER_EIP712_TYPES = {
    Order: [
        { name: "salt", type: "uint256" },
        { name: "maker", type: "address" },
        { name: "signer", type: "address" },
        { name: "taker", type: "address" },
        { name: "tokenId", type: "uint256" },
        { name: "makerAmount", type: "uint256" },
        { name: "takerAmount", type: "uint256" },
        { name: "expiration", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "feeRateBps", type: "uint256" },
        { name: "side", type: "uint8" },
        { name: "signatureType", type: "uint8" },
    ],
} as const

export function calculateOrderAmounts(
    side: "buy" | "sell",
    size: number,
    price: number
): { makerAmount: bigint; takerAmount: bigint } {
    if (side === "buy") {
        return {
            makerAmount: toRawAmount(size * price),
            takerAmount: toRawAmount(size),
        }
    }
    return {
        makerAmount: toRawAmount(size),
        takerAmount: toRawAmount(size * price),
    }
}

export function roundToTickSize(price: number, tickSize: string): number {
    const tick = Number(tickSize)
    if (tick <= 0) return price
    return Math.round(price / tick) * tick
}

export function derivePolymarketSalt(
    canonicalOrderId: string,
    payload: unknown
): bigint {
    const hash = createHash("sha256")
        .update(canonicalOrderId)
        .update("|")
        .update(stableStringify(payload))
        .digest("hex")
    return BigInt("0x" + hash)
}

export function fingerprintPolymarketSignedOrder(order: unknown): string {
    return createHash("sha256")
        .update(stableStringify(order))
        .digest("hex")
}

function toRawAmount(amount: number): bigint {
    return BigInt(Math.floor(amount * AMOUNT_MULTIPLIER))
}

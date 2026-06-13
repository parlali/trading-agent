import { getAddress, isAddress } from "viem"
import { requireResolvedSecret } from "@valiq-trading/core"
import type { PolymarketCredentials } from "./polymarket-client"

export const POLYMARKET_RUNTIME_SECRET_KEYS = [
    "POLYMARKET_PRIVATE_KEY",
    "POLYMARKET_API_KEY",
    "POLYMARKET_API_SECRET",
    "POLYMARKET_API_PASSPHRASE",
    "POLYMARKET_HOST",
    "POLYMARKET_CHAIN_ID",
    "POLYMARKET_FUNDER_ADDRESS",
] as const

export function resolvePolymarketFunderAddress(
    secrets: Record<string, string | null>
): string {
    const funderAddress = requireResolvedSecret(secrets, "POLYMARKET_FUNDER_ADDRESS").trim()

    if (!isAddress(funderAddress)) {
        throw new Error(
            "POLYMARKET_FUNDER_ADDRESS must be a valid 0x wallet address for the Polymarket profile or proxy wallet"
        )
    }

    return getAddress(funderAddress)
}

export function resolvePolymarketCredentials(
    secrets: Record<string, string | null>
): PolymarketCredentials {
    return {
        privateKey: requireResolvedSecret(secrets, "POLYMARKET_PRIVATE_KEY"),
        apiKey: requireResolvedSecret(secrets, "POLYMARKET_API_KEY"),
        apiSecret: requireResolvedSecret(secrets, "POLYMARKET_API_SECRET"),
        apiPassphrase: requireResolvedSecret(secrets, "POLYMARKET_API_PASSPHRASE"),
        host: secrets.POLYMARKET_HOST ?? undefined,
        chainId: resolvePolymarketChainId(secrets.POLYMARKET_CHAIN_ID),
        funderAddress: resolvePolymarketFunderAddress(secrets),
    }
}

function resolvePolymarketChainId(rawChainId: string | null | undefined): number | undefined {
    const normalized = rawChainId?.trim()
    if (!normalized) {
        return undefined
    }

    const chainId = Number(normalized)
    if (!Number.isInteger(chainId) || chainId <= 0) {
        throw new Error("POLYMARKET_CHAIN_ID must be a positive integer when provided")
    }

    return chainId
}

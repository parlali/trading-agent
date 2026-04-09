import { getAddress, isAddress } from "viem";
import { requireResolvedSecret } from "@valiq-trading/core";
export const POLYMARKET_RUNTIME_SECRET_KEYS = [
    "POLYMARKET_PRIVATE_KEY",
    "POLYMARKET_API_KEY",
    "POLYMARKET_API_SECRET",
    "POLYMARKET_API_PASSPHRASE",
    "POLYMARKET_HOST",
    "POLYMARKET_CHAIN_ID",
    "POLYMARKET_FUNDER_ADDRESS",
];
export function resolvePolymarketFunderAddress(secrets) {
    const funderAddress = requireResolvedSecret(secrets, "POLYMARKET_FUNDER_ADDRESS").trim();
    if (!isAddress(funderAddress)) {
        throw new Error("POLYMARKET_FUNDER_ADDRESS must be a valid 0x wallet address for the Polymarket profile or proxy wallet");
    }
    return getAddress(funderAddress);
}
export function resolvePolymarketCredentials(secrets) {
    return {
        privateKey: requireResolvedSecret(secrets, "POLYMARKET_PRIVATE_KEY"),
        apiKey: requireResolvedSecret(secrets, "POLYMARKET_API_KEY"),
        apiSecret: requireResolvedSecret(secrets, "POLYMARKET_API_SECRET"),
        apiPassphrase: requireResolvedSecret(secrets, "POLYMARKET_API_PASSPHRASE"),
        host: secrets.POLYMARKET_HOST ?? undefined,
        chainId: secrets.POLYMARKET_CHAIN_ID
            ? Number(secrets.POLYMARKET_CHAIN_ID)
            : undefined,
        funderAddress: resolvePolymarketFunderAddress(secrets),
    };
}

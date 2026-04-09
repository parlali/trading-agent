import { privateKeyToAccount } from "viem/accounts";
import { fetchWithTimeout } from "@valiq-trading/core";
const HOST = "https://clob.polymarket.com";
const REQUEST_TIMEOUT_MS = 30_000;
async function main() {
    const privateKey = process.argv[2];
    if (!privateKey) {
        console.error("Usage: bun run packages/polymarket/src/derive-api-key.ts <private-key>");
        console.error("  private-key: your Polymarket wallet private key (with or without 0x prefix)");
        process.exit(1);
    }
    const pk = privateKey.startsWith("0x")
        ? privateKey
        : `0x${privateKey}`;
    const account = privateKeyToAccount(pk);
    console.log(`Wallet address: ${account.address}`);
    console.log(`Deriving CLOB API key from ${HOST}...\n`);
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = 0;
    const signature = await account.signTypedData({
        domain: {
            name: "ClobAuthDomain",
            version: "1",
            chainId: 137,
        },
        types: {
            ClobAuth: [
                { name: "address", type: "address" },
                { name: "timestamp", type: "string" },
                { name: "nonce", type: "uint256" },
                { name: "message", type: "string" },
            ],
        },
        primaryType: "ClobAuth",
        message: {
            address: account.address,
            timestamp: String(timestamp),
            nonce: BigInt(nonce),
            message: "This message attests that I control the given wallet",
        },
    });
    const response = await fetchWithTimeout(`${HOST}/auth/derive-api-key`, {
        method: "GET",
        headers: {
            POLY_ADDRESS: account.address,
            POLY_SIGNATURE: signature,
            POLY_TIMESTAMP: String(timestamp),
            POLY_NONCE: String(nonce),
        },
    }, REQUEST_TIMEOUT_MS, "Polymarket derive API key request");
    if (!response.ok) {
        const text = await response.text();
        console.error(`Failed to derive API key: ${response.status} ${response.statusText}`);
        console.error(text);
        process.exit(1);
    }
    const data = await response.json();
    console.log("Add these to your Convex environment variables:\n");
    console.log(`POLYMARKET_API_KEY=${data.apiKey}`);
    console.log(`POLYMARKET_API_SECRET=${data.secret}`);
    console.log(`POLYMARKET_API_PASSPHRASE=${data.passphrase}`);
    console.log(`POLYMARKET_PRIVATE_KEY=${privateKey}`);
    console.log(`POLYMARKET_FUNDER_ADDRESS=<your Polymarket profile wallet address>`);
    console.log("");
    console.log("POLYMARKET_FUNDER_ADDRESS must be the profile or proxy wallet shown in Polymarket.");
    console.log("Do not copy the signer wallet from the exported private key unless it is also your profile wallet.");
    console.log("Validate the pair in Dashboard > Test > Polymarket before scheduling live runs.");
}
await main();

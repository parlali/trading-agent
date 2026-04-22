import { chmod, mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { privateKeyToAccount } from "viem/accounts"
import { fetchWithTimeout } from "@valiq-trading/core"

const HOST = "https://clob.polymarket.com"
const REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_OUTPUT_PATH = "private/polymarket-credentials.env"

type DerivedCredentials = {
    apiKey: string
    secret: string
    passphrase: string
}

type CliOptions = {
    outputPath: string
    privateKey: string
    stdout: boolean
}

function usage(): string {
    return [
        "Usage: bun run packages/polymarket/src/derive-api-key.ts <private-key> [--out <path> | --stdout]",
        "  private-key: your Polymarket wallet private key (with or without 0x prefix)",
        `  --out <path>: write secrets to a file instead of stdout (default: ${DEFAULT_OUTPUT_PATH})`,
        "  --stdout: print secrets to stdout explicitly",
    ].join("\n")
}

export function getDefaultOutputPath(cwd: string = process.cwd()): string {
    return resolve(cwd, DEFAULT_OUTPUT_PATH)
}

export function parseCliArgs(argv: string[], cwd: string = process.cwd()): CliOptions {
    let outputPath = getDefaultOutputPath(cwd)
    let privateKey: string | null = null
    let stdout = false

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index]
        if (arg === undefined) {
            throw new Error("Missing CLI argument")
        }

        if (arg === "--out") {
            const nextArg = argv[index + 1]
            if (!nextArg) {
                throw new Error("--out requires a path")
            }
            outputPath = resolve(cwd, nextArg)
            index += 1
            continue
        }

        if (arg === "--stdout") {
            stdout = true
            continue
        }

        if (arg.startsWith("--")) {
            throw new Error(`Unknown option: ${arg}`)
        }

        if (privateKey) {
            throw new Error("Expected exactly one private key argument")
        }

        privateKey = arg
    }

    if (!privateKey) {
        throw new Error(usage())
    }

    if (stdout && outputPath !== getDefaultOutputPath(cwd)) {
        throw new Error("Use either --stdout or --out, not both")
    }

    return {
        outputPath,
        privateKey,
        stdout,
    }
}

export function formatEnvFileContents(
    credentials: DerivedCredentials,
    privateKey: string
): string {
    return [
        `POLYMARKET_API_KEY=${credentials.apiKey}`,
        `POLYMARKET_API_SECRET=${credentials.secret}`,
        `POLYMARKET_API_PASSPHRASE=${credentials.passphrase}`,
        `POLYMARKET_PRIVATE_KEY=${privateKey}`,
        "POLYMARKET_FUNDER_ADDRESS=<your Polymarket profile wallet address>",
        "",
    ].join("\n")
}

async function writeSecureFile(path: string, contents: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, contents, "utf8")
    await chmod(path, 0o600)
}

function isDirectExecution(): boolean {
    return resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)
}

async function main(argv: string[] = process.argv.slice(2)) {
    const options = parseCliArgs(argv)
    const privateKey = options.privateKey

    if (!privateKey) {
        throw new Error(usage())
    }

    const pk = privateKey.startsWith("0x")
        ? privateKey as `0x${string}`
        : `0x${privateKey}` as `0x${string}`

    const account = privateKeyToAccount(pk)

    console.log(`Wallet address: ${account.address}`)
    console.log(`Deriving CLOB API key from ${HOST}...\n`)

    const timestamp = Math.floor(Date.now() / 1000)
    const nonce = 0

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
    })

    const response = await fetchWithTimeout(`${HOST}/auth/derive-api-key`, {
        method: "GET",
        headers: {
            POLY_ADDRESS: account.address,
            POLY_SIGNATURE: signature,
            POLY_TIMESTAMP: String(timestamp),
            POLY_NONCE: String(nonce),
        },
    }, REQUEST_TIMEOUT_MS, "Polymarket derive API key request")

    if (!response.ok) {
        const text = await response.text()
        console.error(`Failed to derive API key: ${response.status} ${response.statusText}`)
        console.error(text)
        process.exit(1)
    }

    const data = await response.json() as DerivedCredentials
    const envFileContents = formatEnvFileContents(data, privateKey)

    if (options.stdout) {
        process.stdout.write(envFileContents)
        return
    }

    await writeSecureFile(options.outputPath, envFileContents)

    console.log(`Wrote derived credentials to ${options.outputPath}\n`)
    console.log("POLYMARKET_FUNDER_ADDRESS must be the profile or proxy wallet shown in Polymarket.")
    console.log("Do not copy the signer wallet from the exported private key unless it is also your profile wallet.")
    console.log("Validate the pair in Dashboard > Test > Polymarket before scheduling live runs.")
}

if (isDirectExecution()) {
    void main().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        console.error(message)
        process.exit(1)
    })
}

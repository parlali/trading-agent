import { requireResolvedSecret } from "@valiq-trading/core"
import type { OKXCredentials, OKXMarginMode, OKXPositionMode } from "./okx-client"

export interface OKXRuntimeConfig {
    credentials: OKXCredentials
    marginMode: OKXMarginMode
    positionMode: OKXPositionMode
}

export const OKX_RUNTIME_SECRET_KEYS = [
    "OKX_API_KEY",
    "OKX_API_SECRET",
    "OKX_API_PASSPHRASE",
    "OKX_BASE_URL",
    "OKX_DEMO_TRADING",
    "OKX_MARGIN_MODE",
    "OKX_POSITION_MODE",
] as const

export function resolveOKXRuntimeConfig(
    secrets: Record<string, string | null>
): OKXRuntimeConfig {
    const marginMode = parseMarginMode(
        requireResolvedSecret(secrets, "OKX_MARGIN_MODE")
    )
    const positionMode = parsePositionMode(
        requireResolvedSecret(secrets, "OKX_POSITION_MODE")
    )

    return {
        credentials: {
            apiKey: requireResolvedSecret(secrets, "OKX_API_KEY"),
            apiSecret: requireResolvedSecret(secrets, "OKX_API_SECRET"),
            apiPassphrase: requireResolvedSecret(secrets, "OKX_API_PASSPHRASE"),
            baseUrl: secrets.OKX_BASE_URL ?? undefined,
            demoTrading: parseBooleanSecret(
                requireResolvedSecret(secrets, "OKX_DEMO_TRADING"),
                "OKX_DEMO_TRADING"
            ),
        },
        marginMode,
        positionMode,
    }
}

function parseMarginMode(value: string): OKXMarginMode {
    if (value === "cross" || value === "isolated") {
        return value
    }

    throw new Error("OKX_MARGIN_MODE must be cross or isolated")
}

function parsePositionMode(value: string): OKXPositionMode {
    if (value === "net_mode" || value === "long_short_mode") {
        return value
    }

    throw new Error("OKX_POSITION_MODE must be net_mode or long_short_mode")
}

function parseBooleanSecret(value: string, key: string): boolean {
    const normalized = value.trim().toLowerCase()

    if (normalized === "true") {
        return true
    }

    if (normalized === "false") {
        return false
    }

    throw new Error(`${key} must be true or false`)
}

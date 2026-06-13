import type { VenueApp } from "./app-types"

export interface AccountCredentialRef {
    credentialEnvPrefix: string
}

export function resolveAccountScopedSecretKeys(
    app: VenueApp,
    keys: string[]
): string[] {
    return Array.from(new Set(keys.filter((key) => isAccountScopedSecretKey(app, key))))
}

export function buildAccountSecretKeyMap(
    account: AccountCredentialRef,
    canonicalKeys: string[]
): Map<string, string> {
    return new Map(canonicalKeys.map((key) => [
        key,
        buildAccountScopedSecretKey(account.credentialEnvPrefix, key),
    ]))
}

function isAccountScopedSecretKey(app: VenueApp, key: string): boolean {
    if (app === "mt5") {
        return key === "MT5_PRIMARY_LOGIN" ||
            key === "MT5_PRIMARY_PASSWORD" ||
            key === "MT5_PRIMARY_SERVER"
    }

    if (app === "okx-swap") {
        return key.startsWith("OKX_")
    }

    if (app === "polymarket") {
        return key.startsWith("POLYMARKET_")
    }

    if (app === "alpaca-options") {
        return key.startsWith("ALPACA_")
    }

    return false
}

function buildAccountScopedSecretKey(prefix: string, canonicalKey: string): string {
    const separatorIndex = canonicalKey.indexOf("_")
    const suffix = separatorIndex >= 0
        ? canonicalKey.slice(separatorIndex + 1)
        : canonicalKey

    return `${prefix}_${suffix}`
}

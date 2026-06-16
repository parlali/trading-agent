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
    const normalizedPrefix = prefix.trim()
    const normalizedKey = canonicalKey.trim()
    const prefixParts = normalizedPrefix.split("_").filter((part) => part.length > 0)
    const keyParts = normalizedKey.split("_").filter((part) => part.length > 0)
    const base = prefixParts[0]

    if (!base || keyParts[0] !== base) {
        return `${normalizedPrefix}_${normalizedKey}`
    }

    const keySuffixParts = keyParts.slice(1)
    const prefixQualifier = prefixParts[1]
    const startsWithSameQualifier = prefixQualifier !== undefined &&
        keySuffixParts[0] === prefixQualifier
    const startsWithCanonicalPrimary = keySuffixParts[0] === "PRIMARY" &&
        prefixParts.length > 1
    const shouldStripCanonicalQualifier = startsWithSameQualifier || startsWithCanonicalPrimary
    const suffixParts = shouldStripCanonicalQualifier
        ? keySuffixParts.slice(1)
        : keySuffixParts
    const suffix = suffixParts.join("_")

    if (!suffix) {
        return normalizedPrefix
    }

    return `${normalizedPrefix}_${suffix}`
}

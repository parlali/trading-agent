import type { StoredAccount, StoredStrategy } from "@valiq-trading/convex"
import {
    buildAccountSecretKeyMap,
    compareCodeUnits,
    sha256Hex,
    stableJsonKey,
} from "@valiq-trading/core"
import { backend } from "./state"
import type { VenueApp } from "./types"

const STRATEGY_SECRET_CACHE_TTL_MS = 15 * 60 * 1000

type CachedStrategySecrets = {
    app: VenueApp
    accountId: string
    resolvedAt: number
    secrets: Record<string, string | null>
}

const strategySecretsCache = new Map<string, CachedStrategySecrets>()

export async function resolveCachedStrategySecrets(args: {
    app: VenueApp
    strategy: StoredStrategy
    account: StoredAccount
    accountScopedKeys: string[]
    additionalSharedSecretKeys: string[]
    fresh?: boolean
}): Promise<Record<string, string | null>> {
    const accountSecretKeyMap = buildAccountSecretKeyMap(args.account, args.accountScopedKeys)
    const cacheKey = buildStrategySecretCacheKey({
        app: args.app,
        strategy: args.strategy,
        account: args.account,
        accountScopedKeys: args.accountScopedKeys,
        additionalSharedSecretKeys: args.additionalSharedSecretKeys,
    })
    const now = Date.now()
    pruneExpiredStrategySecretEntries(now)
    const cached = strategySecretsCache.get(cacheKey)

    if (
        args.fresh !== true &&
        cached &&
        now >= cached.resolvedAt &&
        now - cached.resolvedAt < STRATEGY_SECRET_CACHE_TTL_MS
    ) {
        return { ...cached.secrets }
    }

    if (cached) {
        strategySecretsCache.delete(cacheKey)
    }

    const requestedSecretKeys = uniqueSortedStrings([
        ...Array.from(accountSecretKeyMap.values()),
        ...args.additionalSharedSecretKeys,
    ])
    const resolvedSecrets = requestedSecretKeys.length > 0
        ? await backend.resolveSecrets(requestedSecretKeys)
        : {}
    const accountSecrets = Object.fromEntries(
        Array.from(accountSecretKeyMap.entries()).map(([canonicalKey, prefixedKey]) => [
            canonicalKey,
            resolvedSecrets[prefixedKey] ?? null,
        ])
    )
    const additionalSecrets = Object.fromEntries(
        args.additionalSharedSecretKeys.map((key) => [
            key,
            resolvedSecrets[key] ?? null,
        ])
    )
    const secrets = {
        ...additionalSecrets,
        ...accountSecrets,
    }

    strategySecretsCache.set(cacheKey, {
        app: args.app,
        accountId: args.account.accountId,
        resolvedAt: now,
        secrets,
    })

    return { ...secrets }
}

export function invalidateStrategySecretCacheForAccount(
    app: VenueApp,
    accountId: string
): number {
    let invalidated = 0

    for (const [cacheKey, cached] of strategySecretsCache) {
        if (cached.app !== app || cached.accountId !== accountId) {
            continue
        }

        strategySecretsCache.delete(cacheKey)
        invalidated++
    }

    return invalidated
}

export function clearStrategySecretCache(): void {
    strategySecretsCache.clear()
}

function pruneExpiredStrategySecretEntries(now: number): void {
    for (const [cacheKey, cached] of strategySecretsCache) {
        if (now < cached.resolvedAt || now - cached.resolvedAt >= STRATEGY_SECRET_CACHE_TTL_MS) {
            strategySecretsCache.delete(cacheKey)
        }
    }
}

function buildStrategySecretCacheKey(args: {
    app: VenueApp
    strategy: StoredStrategy
    account: StoredAccount
    accountScopedKeys: string[]
    additionalSharedSecretKeys: string[]
}): string {
    return stableJsonKey({
        app: args.app,
        strategyId: args.strategy._id,
        strategyVersionSignal: resolveStrategyVersionSignal(args.strategy),
        accountId: args.account.accountId,
        accountCredentialStateHash: hashAccountCredentialState(args.account),
        accountScopedKeys: uniqueSortedStrings(args.accountScopedKeys),
        additionalSharedSecretKeys: uniqueSortedStrings(args.additionalSharedSecretKeys),
    })
}

function hashAccountCredentialState(account: StoredAccount): string {
    return sha256Hex(stableJsonKey({
        credentialEnvPrefix: account.credentialEnvPrefix,
        status: account.status,
    }))
}

function resolveStrategyVersionSignal(strategy: StoredStrategy): number {
    return strategy.updatedAt ?? strategy._creationTime
}

function uniqueSortedStrings(values: string[]): string[] {
    return Array.from(new Set(values)).sort(compareCodeUnits)
}

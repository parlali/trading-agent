import type { StoredAccount, StoredStrategy } from "@valiq-trading/convex"
import {
    resolveAccountScopedSecretKeys,
    validatePolicy,
    type Scheduler,
} from "@valiq-trading/core"
import type { VenueApp } from "./types"
import { getCronStartDelayMs } from "./schedule-stagger"
import type { SyncStrategyEntry } from "./state"
import {
    backend,
    logger,
    plugins,
    resolvedSecrets,
    syncStrategies,
} from "./state"
import { runStrategy } from "./scheduler-runner"
import {
    clearStrategySecretCache,
    resolveCachedStrategySecrets,
} from "./strategy-runtime-secret-cache"

export { invalidateStrategySecretCacheForAccount } from "./strategy-runtime-secret-cache"

export const pendingManualTriggers = new Set<string>()

export type StrategyRuntimeAccountSnapshot = ReadonlyMap<string, StoredAccount>

const pendingAccountSnapshots = new Map<VenueApp, Promise<StrategyRuntimeAccountSnapshot>>()

export async function registerStrategyWithScheduler(
    scheduler: Scheduler,
    app: VenueApp,
    strategy: StoredStrategy,
    accountSnapshot?: StrategyRuntimeAccountSnapshot
): Promise<void> {
    const plugin = plugins[app]
    if (!plugin) {
        logger.warn("No plugin registered for app, skipping strategy", { app, strategyId: strategy._id })
        return
    }
    const runtimeEntry = await resolveStrategyRuntimeState(app, strategy, accountSnapshot)
    upsertSyncStrategyEntry(app, runtimeEntry)

    scheduler.register({
        strategyId: strategy._id,
        scheduleType: "cron",
        cronExpression: runtimeEntry.strategy.schedule,
        handler: async () => {
            const latestStrategy = await backend.getStrategyById(strategy._id)

            if (!latestStrategy) {
                logger.info("Skipping scheduled run for deleted strategy", {
                    strategyId: strategy._id,
                    app,
                })
                pendingManualTriggers.delete(strategy._id)
                return
            }

            if (!latestStrategy.enabled) {
                logger.info("Skipping scheduled run for disabled strategy", {
                    strategyId: strategy._id,
                    app,
                })
                pendingManualTriggers.delete(strategy._id)
                return
            }

            const latestRuntimeEntry = await resolveStrategyRuntimeState(app, latestStrategy, undefined, {
                freshSecrets: true,
            })
            upsertSyncStrategyEntry(app, latestRuntimeEntry)

            const isManual = pendingManualTriggers.delete(strategy._id)
            const trigger = isManual ? "manual" : "cron"
            const runAt = new Date()
            const startDelayMs = trigger === "cron"
                ? getCronStartDelayMs(app, latestRuntimeEntry.strategy, syncStrategies[app] ?? [], runAt)
                : 0

            if (startDelayMs > 0) {
                logger.info("Delaying cron start to stagger same-minute strategy runs", {
                    strategyId: latestRuntimeEntry.strategy._id,
                    app,
                    delayMs: startDelayMs,
                    schedule: latestRuntimeEntry.strategy.schedule,
                })
                await sleep(startDelayMs)
            }

            await runStrategy(
                app,
                plugin,
                latestRuntimeEntry.strategy,
                latestRuntimeEntry.policy,
                latestRuntimeEntry.secrets,
                scheduler,
                trigger
            )
        },
    })
}

export async function resolveStrategyRuntimeState(
    app: VenueApp,
    strategy: StoredStrategy,
    accountSnapshot?: StrategyRuntimeAccountSnapshot,
    options?: { freshSecrets?: boolean }
): Promise<SyncStrategyEntry> {
    const plugin = plugins[app]
    if (!plugin) {
        throw new Error(`No plugin registered for ${app}`)
    }

    const policy = validatePolicy(app, strategy.policy)
    const additionalSecretKeys = plugin.resolveAdditionalSecretKeys?.(policy) ?? []
    const accountsById = accountSnapshot ?? await createStrategyRuntimeAccountSnapshot(app)
    const account = accountsById.get(strategy.accountId) ?? null
    if (!account) {
        throw new Error(`Strategy ${strategy.name} (${strategy._id}) references missing account ${app}:${strategy.accountId}`)
    }
    if (account.status !== "active") {
        throw new Error(`Strategy ${strategy.name} (${strategy._id}) references inactive account ${app}:${strategy.accountId}`)
    }

    const accountScopedKeys = resolveAccountScopedSecretKeys(app, [
        ...plugin.resolveSecretKeys(),
        ...additionalSecretKeys,
    ])
    const accountScopedKeySet = new Set(accountScopedKeys)
    const additionalSharedSecretKeys = additionalSecretKeys.filter((key) => !accountScopedKeySet.has(key))
    const strategySecrets = await resolveCachedStrategySecrets({
        app,
        strategy,
        account,
        accountScopedKeys,
        additionalSharedSecretKeys,
        fresh: options?.freshSecrets === true,
    })

    return {
        strategy,
        account,
        policy,
        secrets: {
            ...resolvedSecrets,
            ...strategySecrets,
        },
    }
}

export async function createStrategyRuntimeAccountSnapshot(
    app: VenueApp
): Promise<StrategyRuntimeAccountSnapshot> {
    const pending = pendingAccountSnapshots.get(app)
    if (pending) {
        return await pending
    }

    const read = backend.getAccounts(app).then((accounts) => indexAccountsById(app, accounts))
    pendingAccountSnapshots.set(app, read)

    try {
        return await read
    } finally {
        if (pendingAccountSnapshots.get(app) === read) {
            pendingAccountSnapshots.delete(app)
        }
    }
}

export function clearStrategyRuntimeResolutionCaches(): void {
    pendingAccountSnapshots.clear()
    clearStrategySecretCache()
}

export function upsertSyncStrategyEntry(
    app: VenueApp,
    entry: SyncStrategyEntry
): void {
    syncStrategies[app] ??= []
    const existingIndex = syncStrategies[app].findIndex(
        (candidate) => candidate.strategy._id === entry.strategy._id
    )

    if (existingIndex === -1) {
        syncStrategies[app].push(entry)
        return
    }

    syncStrategies[app][existingIndex] = entry
}

export function syncStrategyEntryChanged(
    current: SyncStrategyEntry,
    next: SyncStrategyEntry
): boolean {
    return stableStringify({
        account: current.account,
        strategy: current.strategy,
        policy: current.policy,
        secrets: current.secrets,
    }) !== stableStringify({
        account: next.account,
        strategy: next.strategy,
        policy: next.policy,
        secrets: next.secrets,
    })
}

async function sleep(delayMs: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
}

function indexAccountsById(
    app: VenueApp,
    accounts: StoredAccount[]
): StrategyRuntimeAccountSnapshot {
    const indexed = new Map<string, StoredAccount>()

    for (const account of accounts) {
        if (account.app !== app) {
            throw new Error(`Account batch for ${app} included ${account.app}:${account.accountId}`)
        }
        if (indexed.has(account.accountId)) {
            throw new Error(`Account batch for ${app} included duplicate account ${account.accountId}`)
        }

        indexed.set(account.accountId, account)
    }

    return indexed
}

function stableStringify(value: unknown): string {
    return JSON.stringify(sortJsonValue(value))
}

function sortJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map((entry) => sortJsonValue(entry))
    }

    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, entry]) => [key, sortJsonValue(entry)])
        )
    }

    return value
}

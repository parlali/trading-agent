import type { StoredStrategy } from "@valiq-trading/convex"
import {
    buildAccountSecretKeyMap,
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

export const pendingManualTriggers = new Set<string>()

export async function registerStrategyWithScheduler(
    scheduler: Scheduler,
    app: VenueApp,
    strategy: StoredStrategy
): Promise<void> {
    const plugin = plugins[app]
    if (!plugin) {
        logger.warn("No plugin registered for app, skipping strategy", { app, strategyId: strategy._id })
        return
    }
    const runtimeEntry = await resolveStrategyRuntimeState(app, strategy)
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

            const latestRuntimeEntry = await resolveStrategyRuntimeState(app, latestStrategy)
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
    strategy: StoredStrategy
): Promise<SyncStrategyEntry> {
    const plugin = plugins[app]
    if (!plugin) {
        throw new Error(`No plugin registered for ${app}`)
    }

    const policy = validatePolicy(app, strategy.policy)
    const additionalSecretKeys = plugin.resolveAdditionalSecretKeys?.(policy) ?? []
    const account = await backend.getAccountByAppAndId(app, strategy.accountId)
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
    const accountSecretKeyMap = buildAccountSecretKeyMap(account, accountScopedKeys)
    const prefixedAccountSecrets = accountSecretKeyMap.size > 0
        ? await backend.resolveSecrets(Array.from(accountSecretKeyMap.values()))
        : {}
    const accountScopedKeySet = new Set(accountScopedKeys)
    const additionalSharedSecretKeys = additionalSecretKeys.filter((key) => !accountScopedKeySet.has(key))
    const additionalSecrets =
        additionalSharedSecretKeys.length > 0
            ? await backend.resolveSecrets(additionalSharedSecretKeys)
            : {}
    const accountSecrets = Object.fromEntries(
        Array.from(accountSecretKeyMap.entries()).map(([canonicalKey, prefixedKey]) => [
            canonicalKey,
            prefixedAccountSecrets[prefixedKey] ?? null,
        ])
    )

    return {
        strategy,
        account,
        policy,
        secrets: {
            ...resolvedSecrets,
            ...additionalSecrets,
            ...accountSecrets,
        },
    }
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

import { AsyncLocalStorage } from "node:async_hooks"
import type { VenueApp } from "./types"
import type { Logger } from "@valiq-trading/core"

export type ProviderAccountOperationSource =
    | "startup_sync"
    | "periodic_sync"
    | "post_run_sync"
    | "order_lifecycle"

export interface ProviderAccountOperationActiveState {
    app: VenueApp
    accountId: string
    source: ProviderAccountOperationSource
    label: string
    startedAt: number
}

export type ProviderAccountOperationResult<T> = {
    status: "completed"
    value: T
} | {
    status: "skipped"
    reason: string
    active?: ProviderAccountOperationActiveState
}

interface ProviderAccountLockState {
    tail: Promise<void>
    queued: number
    active?: ProviderAccountOperationActiveState
}

const providerAccountLocks = new Map<string, ProviderAccountLockState>()
const providerAccountOperationContext = new AsyncLocalStorage<string>()

export function resetProviderAccountCoordinatorForTests(): void {
    providerAccountLocks.clear()
    providerAccountOperationContext.disable()
}

export function getProviderAccountOperationState(
    app: VenueApp,
    accountId: string
): ProviderAccountOperationActiveState | undefined {
    return providerAccountLocks.get(providerAccountKey(app, accountId))?.active
}

export async function runProviderAccountOperation<T>(
    args: {
        app: VenueApp
        accountId: string
        source: ProviderAccountOperationSource
        label: string
        logger: Pick<Logger, "info" | "warn">
        skipIfBusy?: boolean
    },
    operation: () => Promise<T>
): Promise<ProviderAccountOperationResult<T>> {
    const key = providerAccountKey(args.app, args.accountId)
    if (providerAccountOperationContext.getStore() === key) {
        return {
            status: "completed",
            value: await operation(),
        }
    }

    const state = providerAccountLocks.get(key) ?? createProviderAccountLockState()
    providerAccountLocks.set(key, state)

    if (args.skipIfBusy && (state.active || state.queued > 0)) {
        const reason = state.active
            ? `${args.source} skipped because ${state.active.source} is active for ${key}`
            : `${args.source} skipped because another provider account operation is queued for ${key}`
        args.logger.info("Provider account operation skipped", {
            app: args.app,
            accountId: args.accountId,
            source: args.source,
            label: args.label,
            activeSource: state.active?.source,
            activeLabel: state.active?.label,
            queued: state.queued,
            reason,
        })
        return {
            status: "skipped",
            reason,
            active: state.active,
        }
    }

    state.queued++
    const previousTail = state.tail.catch(() => undefined)
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
        release = resolve
    })
    const currentTail = previousTail.then(() => gate)
    state.tail = currentTail

    await previousTail
    state.queued--
    state.active = {
        app: args.app,
        accountId: args.accountId,
        source: args.source,
        label: args.label,
        startedAt: Date.now(),
    }

    args.logger.info("Provider account operation started", {
        app: args.app,
        accountId: args.accountId,
        source: args.source,
        label: args.label,
        queued: state.queued,
    })

    try {
        const value = await providerAccountOperationContext.run(key, operation)
        return {
            status: "completed",
            value,
        }
    } finally {
        const elapsedMs = Date.now() - state.active.startedAt
        args.logger.info("Provider account operation finished", {
            app: args.app,
            accountId: args.accountId,
            source: args.source,
            label: args.label,
            elapsedMs,
        })
        state.active = undefined
        release()
        if (state.queued === 0 && state.tail === currentTail) {
            providerAccountLocks.delete(key)
        }
    }
}

function createProviderAccountLockState(): ProviderAccountLockState {
    return {
        tail: Promise.resolve(),
        queued: 0,
    }
}

function providerAccountKey(app: VenueApp, accountId: string): string {
    return `${app}:${accountId}`
}

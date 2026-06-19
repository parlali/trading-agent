import { afterEach, describe, expect, it, vi } from "vitest"
import {
    resetProviderAccountCoordinatorForTests,
    runProviderAccountOperation,
} from "./provider-account-coordinator"

describe("provider account coordinator", () => {
    afterEach(() => {
        resetProviderAccountCoordinatorForTests()
        vi.restoreAllMocks()
    })

    it("serializes provider sync and order lifecycle writes for one account", async () => {
        const events: string[] = []
        const releaseSync = createDeferred<void>()
        const logger = createLogger()

        const sync = runProviderAccountOperation({
            app: "mt5",
            accountId: "account-1",
            source: "post_run_sync",
            label: "post-run provider sync",
            logger,
        }, async () => {
            events.push("sync:start")
            await releaseSync.promise
            events.push("sync:end")
            return "sync"
        })
        await Promise.resolve()

        const orderWrite = runProviderAccountOperation({
            app: "mt5",
            accountId: "account-1",
            source: "order_lifecycle",
            label: "order lifecycle upsertOrder",
            logger,
        }, async () => {
            events.push("order")
            return "order"
        })
        await Promise.resolve()

        expect(events).toEqual(["sync:start"])

        releaseSync.resolve(undefined)
        await expect(sync).resolves.toMatchObject({
            status: "completed",
            value: "sync",
        })
        await expect(orderWrite).resolves.toMatchObject({
            status: "completed",
            value: "order",
        })
        expect(events).toEqual(["sync:start", "sync:end", "order"])
    })

    it("skips periodic sync while an account operation is active", async () => {
        const syncStarted = createDeferred<void>()
        const releaseSync = createDeferred<void>()
        const logger = createLogger()

        const activeSync = runProviderAccountOperation({
            app: "mt5",
            accountId: "account-1",
            source: "post_run_sync",
            label: "post-run provider sync",
            logger,
        }, async () => {
            syncStarted.resolve(undefined)
            await releaseSync.promise
            return "sync"
        })
        await syncStarted.promise

        const periodic = await runProviderAccountOperation({
            app: "mt5",
            accountId: "account-1",
            source: "periodic_sync",
            label: "periodic provider sync",
            logger,
            skipIfBusy: true,
        }, async () => "periodic")

        expect(periodic).toMatchObject({
            status: "skipped",
            active: {
                source: "post_run_sync",
            },
        })

        releaseSync.resolve(undefined)
        await activeSync
    })
})

function createDeferred<T>(): {
    promise: Promise<T>
    resolve: (value: T | PromiseLike<T>) => void
} {
    let resolve: (value: T | PromiseLike<T>) => void = () => undefined
    const promise = new Promise<T>((innerResolve) => {
        resolve = innerResolve
    })
    return {
        promise,
        resolve,
    }
}

function createLogger() {
    return {
        info: vi.fn(),
        warn: vi.fn(),
    }
}

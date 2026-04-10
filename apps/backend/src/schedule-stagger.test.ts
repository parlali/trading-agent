import { describe, expect, it } from "vitest"
import type { StoredStrategy } from "@valiq-trading/convex"
import type { SyncStrategyEntry } from "./state"
import { getCronStartDelayMs } from "./schedule-stagger"

function createStrategy(
    id: string,
    name: string,
    schedule: string
): StoredStrategy {
    return {
        _id: id as StoredStrategy["_id"],
        _creationTime: 0,
        app: "polymarket",
        name,
        enabled: true,
        schedule,
        policy: {
            model: "openai/gpt-5.4",
            dryRun: true,
            maxBet: {
                mode: "percentage",
                value: 10,
            },
        },
        context: "test",
    }
}

function createEntry(strategy: StoredStrategy): SyncStrategyEntry {
    return {
        strategy,
        policy: {},
        secrets: {},
    }
}

describe("getCronStartDelayMs", () => {
    it("stays at zero for non-polymarket apps", () => {
        expect(getCronStartDelayMs("mt5", {
            _id: "strategy-1" as StoredStrategy["_id"],
            name: "MT5",
            schedule: "*/20 * * * *",
        }, [], new Date("2026-04-10T10:00:00Z"))).toBe(0)
    })

    it("staggers polymarket strategies sharing the same cron", () => {
        const alpha = createStrategy("strategy-a", "Alpha", "*/20 * * * *")
        const beta = createStrategy("strategy-b", "Beta", "*/20 * * * *")
        const gamma = createStrategy("strategy-c", "Gamma", "0 * * * *")
        const entries = [
            createEntry(beta),
            createEntry(alpha),
            createEntry(gamma),
        ]
        const runAt = new Date("2026-04-10T10:20:00Z")

        expect(getCronStartDelayMs("polymarket", alpha, entries, runAt)).toBe(0)
        expect(getCronStartDelayMs("polymarket", beta, entries, runAt)).toBe(15_000)
        expect(getCronStartDelayMs("polymarket", gamma, entries, runAt)).toBe(0)
    })

    it("staggers polymarket strategies that collide on the current minute even with different cron strings", () => {
        const alpha = createStrategy("strategy-a", "Alpha", "*/20 * * * *")
        const beta = createStrategy("strategy-b", "Beta", "0,20,40 * * * *")
        const gamma = createStrategy("strategy-c", "Gamma", "10,30,50 * * * *")
        const entries = [
            createEntry(beta),
            createEntry(alpha),
            createEntry(gamma),
        ]
        const runAt = new Date("2026-04-10T10:20:00Z")

        expect(getCronStartDelayMs("polymarket", alpha, entries, runAt)).toBe(0)
        expect(getCronStartDelayMs("polymarket", beta, entries, runAt)).toBe(15_000)
        expect(getCronStartDelayMs("polymarket", gamma, entries, runAt)).toBe(0)
    })

    it("does not stagger polymarket strategies that do not fire on the current minute", () => {
        const alpha = createStrategy("strategy-a", "Alpha", "*/20 * * * *")
        const beta = createStrategy("strategy-b", "Beta", "0,40 * * * *")
        const entries = [
            createEntry(beta),
            createEntry(alpha),
        ]
        const runAt = new Date("2026-04-10T10:20:00Z")

        expect(getCronStartDelayMs("polymarket", alpha, entries, runAt)).toBe(0)
        expect(getCronStartDelayMs("polymarket", beta, entries, runAt)).toBe(0)
    })
})

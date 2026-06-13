import { describe, expect, it } from "vitest"
import {
    createInstrumentConflictValidator,
    createStrategySafetyValidator,
    duplicateOrderValidator,
} from "./risk"
import { withLifecycleAction } from "./execution-metadata"
import type { AccountState, OrderIntent, Position } from "./types"

const accountState: AccountState = {
    balance: 10_000,
    equity: 10_000,
    buyingPower: 10_000,
    marginUsed: 0,
    marginAvailable: 10_000,
    openPnl: 0,
    dayPnl: 0,
}

const positions: Position[] = []

function buildIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
    return {
        instrument: "BTC-USDT-SWAP",
        side: "buy",
        quantity: 1,
        orderType: "market",
        timeInForce: "gtc",
        metadata: {
            action: "entry",
        },
        ...overrides,
    }
}

describe("createStrategySafetyValidator", () => {
    it("allows healthy entries and explicit risk-reducing actions", () => {
        const validator = createStrategySafetyValidator({
            safetyState: "healthy",
        })

        expect(validator(buildIntent(), {}, accountState, positions).allowed).toBe(true)

        const cooldownValidator = createStrategySafetyValidator({
            safetyState: "cooldown",
        })
        const blockedValidator = createStrategySafetyValidator({
            safetyState: "blocked",
        })

        expect(cooldownValidator(buildIntent({
            side: "sell",
            metadata: {
                action: "close",
            },
        }), {}, accountState, positions).allowed).toBe(true)
        expect(blockedValidator(buildIntent({
            metadata: {
                action: "adjustment",
                riskReducing: true,
            },
        }), {}, accountState, positions).allowed).toBe(true)
    })

    it("blocks new risk during cooldown and preserves the specific cooldown reason", () => {
        const validator = createStrategySafetyValidator({
            safetyState: "cooldown",
            reason: "Cooldown active",
        })

        const result = validator(buildIntent(), {}, accountState, positions)
        expect(result.allowed).toBe(false)
        expect(result.reason).toContain("Cooldown active")

        const instrumentValidator = createStrategySafetyValidator({
            safetyState: "cooldown",
            blockedInstruments: new Set(["ETH-USDT-SWAP"]),
            blockedInstrumentReason: "Instrument is blocked because strategy cooldown is active (forced_exit_cluster). Only risk-reducing actions are allowed until the cooldown expires.",
        })
        const instrumentResult = instrumentValidator(buildIntent({ instrument: "ETH-USDT-SWAP" }), {}, accountState, positions)
        expect(instrumentResult.allowed).toBe(false)
        expect(instrumentResult.reason).toContain("forced_exit_cluster")
        expect(instrumentResult.reason).not.toContain("unresolved execution safety faults")
    })

    it("blocks instruments with unresolved safety faults even when strategy state is healthy", () => {
        const validator = createStrategySafetyValidator({
            safetyState: "healthy",
            blockedInstruments: new Set(["ETH-USDT-SWAP"]),
        })

        const result = validator(buildIntent({ instrument: "ETH-USDT-SWAP" }), {}, accountState, positions)
        expect(result.allowed).toBe(false)
        expect(result.reason).toContain("strategy safety governance")
    })

    it("keeps execution degradation scoped when possible and global otherwise", () => {
        const scopedValidator = createStrategySafetyValidator({
            safetyState: "execution_degraded",
            blockedInstruments: new Set(["BTC-USDT-SWAP"]),
        })

        const sameInstrument = scopedValidator(buildIntent({ instrument: "BTC-USDT-SWAP" }), {}, accountState, positions)
        const otherInstrument = scopedValidator(buildIntent({ instrument: "ETH-USDT-SWAP" }), {}, accountState, positions)

        expect(sameInstrument.allowed).toBe(false)
        expect(otherInstrument.allowed).toBe(true)

        const globalValidator = createStrategySafetyValidator({
            safetyState: "execution_degraded",
        })
        const result = globalValidator(buildIntent({ instrument: "ETH-USDT-SWAP" }), {}, accountState, positions)
        expect(result.allowed).toBe(false)
    })
})

describe("createInstrumentConflictValidator", () => {
    const claimedByOther = new Map([["BTC-USDT-SWAP", "strategy-other"]])

    it("gates entries on instruments owned by another strategy", () => {
        const validator = createInstrumentConflictValidator(claimedByOther)

        const result = validator(buildIntent(), {}, accountState, positions)
        expect(result.allowed).toBe(false)
        expect(result.reason).toContain("strategy-other")
    })

    it("treats absent and unknown metadata.action as entry and keeps the gate closed", () => {
        const validator = createInstrumentConflictValidator(claimedByOther)

        expect(validator(buildIntent({ metadata: undefined }), {}, accountState, positions).allowed).toBe(false)
        expect(validator(buildIntent({ metadata: { action: "definitely_not_an_entry" } }), {}, accountState, positions).allowed).toBe(false)
        expect(validator(buildIntent({ metadata: { action: "" } }), {}, accountState, positions).allowed).toBe(false)
    })

    it("gates adjustments and modifies on instruments the strategy does not own", () => {
        const validator = createInstrumentConflictValidator(claimedByOther)

        expect(validator(buildIntent({ metadata: { action: "adjustment" } }), {}, accountState, positions).allowed).toBe(false)
        expect(validator(buildIntent({ metadata: { action: "modify" } }), {}, accountState, positions).allowed).toBe(false)
    })

    it("allows adjustments on instruments not claimed by another strategy", () => {
        const validator = createInstrumentConflictValidator(claimedByOther)

        const result = validator(buildIntent({
            instrument: "ETH-USDT-SWAP",
            metadata: { action: "adjustment" },
        }), {}, accountState, positions)
        expect(result.allowed).toBe(true)
    })

    it("exempts only genuine risk-reducing actions", () => {
        const validator = createInstrumentConflictValidator(claimedByOther)

        expect(validator(buildIntent({ metadata: { action: "close" } }), {}, accountState, positions).allowed).toBe(true)
        expect(validator(buildIntent({ metadata: { action: "cancel" } }), {}, accountState, positions).allowed).toBe(true)
    })

    it("does not let model metadata.action bypass the gate once the lifecycle action is applied", () => {
        const validator = createInstrumentConflictValidator(claimedByOther)
        const modelIntent = buildIntent({ metadata: { action: "cancel" } })

        const gatedIntent = withLifecycleAction(modelIntent, { action: "entry" })

        expect(gatedIntent.metadata?.action).toBe("entry")
        const result = validator(gatedIntent, {}, accountState, positions)
        expect(result.allowed).toBe(false)
        expect(result.reason).toContain("strategy-other")
    })

    it("collides Polymarket outcome tokens of one market through the condition alias", () => {
        const claimedCondition = new Map([
            ["token-yes", "strategy-other"],
            ["polymarket-condition:cond-1", "strategy-other"],
        ])
        const validator = createInstrumentConflictValidator(claimedCondition)

        const noTokenEntry = validator(buildIntent({
            instrument: "token-no",
            metadata: {
                action: "entry",
                conditionId: "cond-1",
            },
        }), {}, accountState, positions)
        expect(noTokenEntry.allowed).toBe(false)
        expect(noTokenEntry.reason).toContain("polymarket-condition:cond-1")

        const otherMarketEntry = validator(buildIntent({
            instrument: "token-other",
            metadata: {
                action: "entry",
                conditionId: "cond-2",
            },
        }), {}, accountState, positions)
        expect(otherMarketEntry.allowed).toBe(true)

        const closeIntent = validator(buildIntent({
            instrument: "token-no",
            metadata: {
                action: "close",
                conditionId: "cond-1",
            },
        }), {}, accountState, positions)
        expect(closeIntent.allowed).toBe(true)
    })
})

describe("duplicateOrderValidator", () => {
    const yesPosition: Position = {
        instrument: "token-yes",
        side: "long",
        quantity: 10,
        entryPrice: 0.4,
        metadata: {
            conditionId: "cond-1",
            tokenId: "token-yes",
        },
    }

    it("blocks buying the opposite outcome token of an already-held market", () => {
        const result = duplicateOrderValidator(buildIntent({
            instrument: "token-no",
            metadata: {
                action: "entry",
                conditionId: "cond-1",
            },
        }), {}, accountState, [yesPosition])

        expect(result.allowed).toBe(false)
        expect(result.reason).toContain("cond-1")
    })

    it("still blocks same-token same-side duplicates", () => {
        const result = duplicateOrderValidator(buildIntent({
            instrument: "token-yes",
            metadata: {
                action: "entry",
                conditionId: "cond-1",
            },
        }), {}, accountState, [yesPosition])

        expect(result.allowed).toBe(false)
    })

    it("allows entries on a different market and sells against the held token", () => {
        const otherMarket = duplicateOrderValidator(buildIntent({
            instrument: "token-other",
            metadata: {
                action: "entry",
                conditionId: "cond-2",
            },
        }), {}, accountState, [yesPosition])
        expect(otherMarket.allowed).toBe(true)

        const sellHeldToken = duplicateOrderValidator(buildIntent({
            instrument: "token-yes",
            side: "sell",
            metadata: {
                action: "close",
                conditionId: "cond-1",
            },
        }), {}, accountState, [yesPosition])
        expect(sellHeldToken.allowed).toBe(true)
    })
})

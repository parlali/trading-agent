import { describe, expect, it } from "vitest"
import { createStrategySafetyValidator } from "./risk"
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

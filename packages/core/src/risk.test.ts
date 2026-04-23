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
    it("allows new entries when strategy safety state is healthy", () => {
        const validator = createStrategySafetyValidator({
            safetyState: "healthy",
        })

        const result = validator(buildIntent(), {}, accountState, positions)
        expect(result.allowed).toBe(true)
    })

    it("blocks new risk during cooldown", () => {
        const validator = createStrategySafetyValidator({
            safetyState: "cooldown",
            reason: "Cooldown active",
        })

        const result = validator(buildIntent(), {}, accountState, positions)
        expect(result.allowed).toBe(false)
        expect(result.reason).toContain("Cooldown active")
    })

    it("allows risk-reducing close actions during cooldown", () => {
        const validator = createStrategySafetyValidator({
            safetyState: "cooldown",
        })

        const result = validator(buildIntent({
            side: "sell",
            metadata: {
                action: "close",
            },
        }), {}, accountState, positions)

        expect(result.allowed).toBe(true)
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

    it("uses the cooldown reason for blocked instruments when cooldown is active", () => {
        const validator = createStrategySafetyValidator({
            safetyState: "cooldown",
            blockedInstruments: new Set(["ETH-USDT-SWAP"]),
            blockedInstrumentReason: "Instrument is blocked because strategy cooldown is active (forced_exit_cluster). Only risk-reducing actions are allowed until the cooldown expires.",
        })

        const result = validator(buildIntent({ instrument: "ETH-USDT-SWAP" }), {}, accountState, positions)
        expect(result.allowed).toBe(false)
        expect(result.reason).toContain("forced_exit_cluster")
        expect(result.reason).not.toContain("unresolved execution safety faults")
    })

    it("allows explicitly risk-reducing adjustments", () => {
        const validator = createStrategySafetyValidator({
            safetyState: "blocked",
        })

        const result = validator(buildIntent({
            metadata: {
                action: "adjustment",
                riskReducing: true,
            },
        }), {}, accountState, positions)

        expect(result.allowed).toBe(true)
    })

    it("keeps execution degradation instrument-scoped when blocked instruments are explicit", () => {
        const validator = createStrategySafetyValidator({
            safetyState: "execution_degraded",
            blockedInstruments: new Set(["BTC-USDT-SWAP"]),
        })

        const sameInstrument = validator(buildIntent({ instrument: "BTC-USDT-SWAP" }), {}, accountState, positions)
        const otherInstrument = validator(buildIntent({ instrument: "ETH-USDT-SWAP" }), {}, accountState, positions)

        expect(sameInstrument.allowed).toBe(false)
        expect(otherInstrument.allowed).toBe(true)
    })

    it("blocks globally when execution is degraded without explicit instrument scope", () => {
        const validator = createStrategySafetyValidator({
            safetyState: "execution_degraded",
        })

        const result = validator(buildIntent({ instrument: "ETH-USDT-SWAP" }), {}, accountState, positions)
        expect(result.allowed).toBe(false)
    })
})

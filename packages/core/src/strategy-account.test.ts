import { describe, expect, it } from "vitest"
import { resolveStrategyAccountState } from "./strategy-account"
import type { AccountState, Position } from "./types"

const providerAccountState: AccountState = {
    balance: 50_000,
    equity: 51_000,
    buyingPower: 45_000,
    marginUsed: 5_000,
    marginAvailable: 45_000,
    openPnl: 1_000,
    dayPnl: 1_000,
}

describe("resolveStrategyAccountState", () => {
    it("uses provider account percentage with strategy-owned PnL and margin", () => {
        const positions: Position[] = [
            {
                instrument: "BTC-USDT-SWAP",
                side: "long",
                quantity: 0.1,
                entryPrice: 80_000,
                unrealizedPnl: 50,
            },
        ]

        const state = resolveStrategyAccountState({
            providerAccountState,
            positions,
            policy: {
                safety: {
                    account: {
                        allocationPercent: 20,
                    },
                },
            },
            realizedPnl: -25,
        })

        expect(state.balance).toBe(10_000)
        expect(state.equity).toBe(10_050)
        expect(state.openPnl).toBe(50)
        expect(state.dayPnl).toBe(25)
        expect(state.marginUsed).toBe(8_000)
        expect(state.buyingPower).toBe(2_050)
    })

    it("caps strategy buying power by the stricter provider available amount percentage", () => {
        const state = resolveStrategyAccountState({
            providerAccountState: {
                ...providerAccountState,
                buyingPower: 5_000,
                marginAvailable: 6_000,
            },
            positions: [],
            policy: {
                safety: {
                    account: {
                        allocationPercent: 50,
                    },
                },
            },
        })

        expect(state.balance).toBe(25_000)
        expect(state.buyingPower).toBe(2_500)
        expect(state.marginAvailable).toBe(2_500)
    })

    it("applies option contract multipliers to fallback strategy margin usage", () => {
        const state = resolveStrategyAccountState({
            providerAccountState,
            positions: [{
                instrument: "SPY260619C00520000",
                side: "short",
                quantity: 2,
                entryPrice: 1.25,
                unrealizedPnl: 0,
            }],
            policy: {
                safety: {
                    account: {
                        allocationPercent: 20,
                    },
                },
            },
        })

        expect(state.marginUsed).toBe(250)
    })

    it("fails closed when live strategy account allocation is missing or invalid", () => {
        for (const policy of [
            {},
            {
                safety: {
                    account: {
                        allocationPercent: 101,
                    },
                },
            },
        ]) {
            expect(() => resolveStrategyAccountState({
                providerAccountState,
                positions: [],
                policy,
            })).toThrow("policy.safety.account.allocationPercent")
        }
    })
})

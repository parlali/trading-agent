import { describe, expect, it, vi } from "vitest"
import type { OKXAccountBalance } from "./okx-client"
import { OKXVenueAdapter } from "./venue-adapter"

function createBalance(overrides: Partial<OKXAccountBalance> = {}): OKXAccountBalance {
    return {
        totalEq: "20500",
        upl: "500",
        availEq: "17000",
        details: [
            {
                ccy: "USDT",
                eq: "20500",
                availEq: "17000",
                cashBal: "20000",
            },
        ],
        ...overrides,
    }
}

describe("OKXVenueAdapter account snapshot semantics", () => {
    it("maps provider truth balance/equity/openPnl/dayPnl without zeroing live exposure", async () => {
        const client = {
            getBalance: vi.fn().mockResolvedValue(createBalance()),
        }

        const adapter = new OKXVenueAdapter(client as never, {
            marginMode: "cross",
            positionMode: "long_short_mode",
        })

        const account = await adapter.getAccountState()

        expect(account.equity).toBe(20500)
        expect(account.openPnl).toBe(500)
        expect(account.dayPnl).toBe(500)
        expect(account.balance).toBe(20000)
        expect(account.marginAvailable).toBe(17000)
    })

    it("fails closed to non-negative balance when provider upl is negative", async () => {
        const client = {
            getBalance: vi.fn().mockResolvedValue(createBalance({
                totalEq: "50",
                upl: "-100",
                availEq: "0",
                details: [],
            })),
        }

        const adapter = new OKXVenueAdapter(client as never, {
            marginMode: "cross",
            positionMode: "net_mode",
        })

        const account = await adapter.getAccountState()

        expect(account.equity).toBe(50)
        expect(account.openPnl).toBe(-100)
        expect(account.dayPnl).toBe(-100)
        expect(account.balance).toBe(150)
    })
})

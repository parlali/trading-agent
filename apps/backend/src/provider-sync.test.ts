import { describe, expect, it } from "vitest"
import type { AccountState, VenueAdapter } from "@valiq-trading/core"
import { readProviderPortfolioForSync } from "./provider-portfolio-read"

const accountState: AccountState = {
    balance: 1000,
    equity: 1000,
    buyingPower: 1000,
    marginUsed: 0,
    marginAvailable: 1000,
    openPnl: 0,
    dayPnl: 0,
}

describe("readProviderPortfolioForSync", () => {
    it("reads MT5 provider portfolio state sequentially", async () => {
        const calls: string[] = []
        let accountFinished = false
        let positionsFinished = false
        let ordersFinished = false

        const venue = {
            getAccountState: async () => {
                calls.push("account:start")
                await new Promise(resolve => setTimeout(resolve, 10))
                accountFinished = true
                calls.push("account:end")
                return accountState
            },
            getPositions: async () => {
                calls.push(accountFinished ? "positions:start" : "positions:started-before-account")
                positionsFinished = true
                calls.push("positions:end")
                return []
            },
            getWorkingOrders: async () => {
                calls.push(positionsFinished ? "orders:start" : "orders:started-before-positions")
                ordersFinished = true
                calls.push("orders:end")
                return []
            },
            getRecentPositionClosures: async () => {
                calls.push(ordersFinished ? "closures:start" : "closures:started-before-orders")
                calls.push("closures:end")
                return []
            },
        } as unknown as VenueAdapter

        await readProviderPortfolioForSync("mt5", venue)

        expect(calls).toEqual([
            "account:start",
            "account:end",
            "positions:start",
            "positions:end",
            "orders:start",
            "orders:end",
            "closures:start",
            "closures:end",
        ])
    })
})

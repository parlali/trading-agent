import { afterEach, describe, expect, it, vi } from "vitest"
import { AlpacaClient } from "@valiq-trading/alpaca-options"
import { AlpacaPlugin } from "../src/plugins/alpaca.ts"

describe("AlpacaPlugin.validateEnvironment", () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("validates trading, options-contract, and market-data runtime paths", async () => {
        const getAccount = vi
            .spyOn(AlpacaClient.prototype, "getAccount")
            .mockResolvedValue({
                id: "account",
                equity: "1000",
                buying_power: "1000",
            })
        const getOptionContracts = vi
            .spyOn(AlpacaClient.prototype, "getOptionContracts")
            .mockResolvedValue({
                contracts: [],
            })
        const getLatestEquityQuote = vi
            .spyOn(AlpacaClient.prototype, "getLatestEquityQuote")
            .mockResolvedValue({
                symbol: "SPY",
            })

        const plugin = new AlpacaPlugin()

        await plugin.validateEnvironment({
            ALPACA_API_KEY: "key",
            ALPACA_SECRET_KEY: "secret",
            ALPACA_ENVIRONMENT: "paper",
            ALPACA_ACCOUNT_ID: null,
        })

        expect(getAccount).toHaveBeenCalledTimes(1)
        expect(getOptionContracts).toHaveBeenCalledWith({
            underlyingSymbol: "SPY",
            limit: 1,
        })
        expect(getLatestEquityQuote).toHaveBeenCalledWith("SPY")
        expect(plugin.getEnvironment()).toBe("paper")
    })
})

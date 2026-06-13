import { describe, expect, it } from "vitest"
import { DryRunExecutionBook } from "./execution-dry-run"

function createBook() {
    const book = new DryRunExecutionBook({ dryRun: true, dryRunInitialCash: 10_000 }, "run-1")
    book.netPosition("BTC-USDT-SWAP", "buy", 2, 100, "entry")
    return book
}

describe("DryRunExecutionBook close accounting", () => {
    it("removes the position and credits only the open quantity when a close overshoots", () => {
        const book = createBook()

        book.netPosition("BTC-USDT-SWAP", "sell", 3, 110, "close")

        expect(book.getPositions()).toEqual([])
        const account = book.getAccountState()
        expect(account.balance).toBe(10_000 + 2 * (110 - 100))
        expect(account.dayPnl).toBe(20)
    })

    it("keeps the remainder open on a partial close", () => {
        const book = createBook()

        book.netPosition("BTC-USDT-SWAP", "sell", 1, 110, "close")

        const positions = book.getPositions()
        expect(positions).toHaveLength(1)
        expect(positions[0]?.quantity).toBe(1)
        expect(positions[0]?.entryPrice).toBe(100)
        expect(book.getAccountState().dayPnl).toBeCloseTo(10)
    })

    it("still allows an entry to flip the position through zero", () => {
        const book = createBook()

        book.netPosition("BTC-USDT-SWAP", "sell", 3, 110, "entry")

        const positions = book.getPositions()
        expect(positions).toHaveLength(1)
        expect(positions[0]?.side).toBe("short")
        expect(positions[0]?.quantity).toBe(1)
        expect(positions[0]?.entryPrice).toBe(110)
    })

    it("applies the option contract multiplier to Alpaca structure cash and PnL", () => {
        const book = new DryRunExecutionBook({ dryRun: true, dryRunInitialCash: 10_000 }, "run-1")

        book.netPosition("VS:SPY:2026-06-19:bear_call_credit:520:525", "sell", 1, 1.2, "entry")
        book.netPosition("VS:SPY:2026-06-19:bear_call_credit:520:525", "buy", 1, 0.7, "close")

        expect(book.getPositions()).toEqual([])
        const account = book.getAccountState()
        expect(account.balance).toBe(10_050)
        expect(account.dayPnl).toBe(50)
    })

    it("applies the option contract multiplier to raw OCC option symbols", () => {
        const book = new DryRunExecutionBook({ dryRun: true, dryRunInitialCash: 10_000 }, "run-1")

        book.netPosition("SPY260619C00520000", "sell", 1, 1.2, "entry")
        book.netPosition("SPY260619C00520000", "buy", 1, 0.7, "close")

        expect(book.getPositions()).toEqual([])
        const account = book.getAccountState()
        expect(account.balance).toBe(10_050)
        expect(account.dayPnl).toBe(50)
    })
})

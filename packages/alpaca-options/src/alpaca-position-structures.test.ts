import { describe, expect, it } from "vitest"
import type { AlpacaPositionResponse } from "./alpaca-client"
import { resolveGroupForClose } from "./alpaca-position-structures"

function leg(
    symbol: string,
    side: "long" | "short",
    overrides: Partial<AlpacaPositionResponse> = {}
): AlpacaPositionResponse {
    return {
        asset_class: "us_option",
        symbol,
        qty: side === "short" ? "-1" : "1",
        side,
        avg_entry_price: side === "short" ? "0.50" : "0.10",
        current_price: side === "short" ? "0.20" : "0.05",
        unrealized_pl: "10",
        ...overrides,
    }
}

const spyBullPut = [
    leg("SPY260626P00730000", "short"),
    leg("SPY260626P00729000", "long"),
]

const qqqBearCall = [
    leg("QQQ260626C00765000", "short"),
    leg("QQQ260626C00766000", "long"),
]

const iwmCondor = [
    leg("IWM260630P00280000", "short"),
    leg("IWM260630P00279000", "long"),
    leg("IWM260630C00306000", "short"),
    leg("IWM260630C00307000", "long"),
]

describe("resolveGroupForClose", () => {
    it("resolves canonical structure ids with explicit leg lists", () => {
        const group = resolveGroupForClose(
            spyBullPut,
            "VS:BULL_PUT_CREDIT:SPY:2026-06-26:SPY260626P00730000|SPY260626P00729000"
        )

        expect(group?.structureType).toBe("credit_vertical")
        expect(group?.verticalSpreadType).toBe("bull_put_credit")
        expect(group?.quantity).toBe(1)
    })

    it("resolves shorthand structure references the model actually sends", () => {
        const references = [
            "VS:BPS:SPY:2026-06-26",
            "VS:bull_put:SPY:2026-06-26",
            "VS:BULL_PUT:SPY:2026-06-26",
        ]

        for (const reference of references) {
            const group = resolveGroupForClose(spyBullPut, reference)
            expect(group?.verticalSpreadType).toBe("bull_put_credit")
            expect(group?.positions.map((position) => position.symbol).sort()).toEqual([
                "SPY260626P00729000",
                "SPY260626P00730000",
            ])
        }
    })

    it("resolves iron condor shorthand without a leg list", () => {
        const group = resolveGroupForClose(iwmCondor, "IC:IWM:2026-06-30")

        expect(group?.structureType).toBe("iron_condor")
        expect(group?.positions).toHaveLength(4)
    })

    it("resolves a full structure from a single member leg symbol", () => {
        const group = resolveGroupForClose(
            [...qqqBearCall, ...spyBullPut],
            "QQQ260626C00765000"
        )

        expect(group?.structureType).toBe("credit_vertical")
        expect(group?.verticalSpreadType).toBe("bear_call_credit")
        expect(group?.positions.map((position) => position.symbol).sort()).toEqual([
            "QQQ260626C00765000",
            "QQQ260626C00766000",
        ])
    })

    it("fails closed when a shorthand reference is ambiguous", () => {
        const twoSpyPutSpreads = [
            leg("SPY260626P00730000", "short"),
            leg("SPY260626P00729000", "long"),
            leg("SPY260626P00720000", "short"),
            leg("SPY260626P00719000", "long"),
        ]

        expect(resolveGroupForClose(twoSpyPutSpreads, "VS:BULL_PUT:SPY:2026-06-26")).toBeNull()
    })

    it("returns null when nothing matches", () => {
        expect(resolveGroupForClose(spyBullPut, "VS:BULL_PUT:SPY:2026-07-10")).toBeNull()
        expect(resolveGroupForClose(spyBullPut, "IC:SPY:2026-06-26")).toBeNull()
        expect(resolveGroupForClose(spyBullPut, "SPY")).toBeNull()
    })
})

import { describe, expect, it } from "vitest"
import {
    getClaimInstrumentsForOrder,
    getOwnedInstrumentsByAppAccount,
    getProviderInstrumentClaimAliases,
} from "../../convex/lib/instrumentClaims"
import { createFakeQueryDb } from "./fakeQueryDb"

describe("getClaimInstrumentsForOrder", () => {
    it("expands grouped Alpaca multi-leg claims into parent, raw-leg, and vertical aliases", () => {
        const expectedClaims = [
            "IC:SPY:2026-04-24:SPY260424C00685000|SPY260424C00686000|SPY260424P00672000|SPY260424P00673000",
            "SPY260424C00685000",
            "SPY260424C00686000",
            "SPY260424P00672000",
            "SPY260424P00673000",
            "VS:BEAR_CALL_CREDIT:SPY:2026-04-24:SPY260424C00685000|SPY260424C00686000",
            "VS:BULL_PUT_CREDIT:SPY:2026-04-24:SPY260424P00672000|SPY260424P00673000",
        ]

        expect(getClaimInstrumentsForOrder(
            "IC:SPY:2026-04-24:SPY260424C00685000|SPY260424C00686000|SPY260424P00672000|SPY260424P00673000",
            {
                legs: [
                    { instrument: "SPY260424P00672000", side: "buy_to_open" },
                    { instrument: "SPY260424P00673000", side: "sell_to_open" },
                    { instrument: "SPY260424C00685000", side: "sell_to_open" },
                    { instrument: "SPY260424C00686000", side: "buy_to_open" },
                ],
            }
        )).toEqual(expectedClaims)
        expect(getProviderInstrumentClaimAliases(
            "alpaca-options",
            "IC:SPY:2026-04-24:SPY260424C00685000|SPY260424C00686000|SPY260424P00672000|SPY260424P00673000",
        )).toEqual(expectedClaims)
    })
})

describe("polymarket condition aliases", () => {
    const conditionId = "0xcond1"
    const conditionAlias = `polymarket-condition:${conditionId}`

    it("claims both the outcome token and the market condition for entry orders", () => {
        expect(getClaimInstrumentsForOrder("token-yes", {
            metadata: {
                tokenId: "token-yes",
                conditionId,
                marketSlug: "will-it-happen",
            },
        })).toEqual(["token-yes", conditionAlias])
    })

    it("keeps token-only claims for orders without canonical market identity", () => {
        expect(getClaimInstrumentsForOrder("token-yes", {
            metadata: {
                tokenId: "token-yes",
            },
        })).toEqual(["token-yes"])
    })

    it("derives the condition alias from record and JSON-string metadata", () => {
        expect(getProviderInstrumentClaimAliases("polymarket", "token-no", {
            conditionId,
        })).toEqual(["token-no", conditionAlias])
        expect(getProviderInstrumentClaimAliases("polymarket", "token-no", JSON.stringify({
            conditionId,
        }))).toEqual(["token-no", conditionAlias])
        expect(getProviderInstrumentClaimAliases("polymarket", "token-no")).toEqual(["token-no"])
    })

    it("expands owned instruments with condition aliases from synced position metadata", async () => {
        const db = createFakeQueryDb({
            strategies: [
                {
                    _id: "strategy-yes",
                    app: "polymarket",
                    accountId: "account-1",
                    createdAt: 1,
                },
                {
                    _id: "strategy-unclaimed",
                    app: "polymarket",
                    accountId: "account-1",
                    createdAt: 2,
                },
            ],
            instrument_claims: [
                {
                    _id: "claim-1",
                    strategyId: "strategy-yes",
                    app: "polymarket",
                    accountId: "account-1",
                    instrument: "token-yes",
                    source: "position",
                    sourceId: "token-yes",
                    updatedAt: 1,
                },
            ],
            position_syncs: [
                {
                    _id: "sync-1",
                    strategyId: "strategy-yes",
                    syncedAt: 100,
                    positionCount: 1,
                },
                {
                    _id: "sync-2",
                    strategyId: "strategy-unclaimed",
                    syncedAt: 100,
                    positionCount: 1,
                },
            ],
            positions: [
                {
                    _id: "position-1",
                    strategyId: "strategy-yes",
                    syncedAt: 100,
                    instrument: "token-yes",
                    metadata: JSON.stringify({
                        tokenId: "token-yes",
                        conditionId,
                    }),
                },
                {
                    _id: "position-2",
                    strategyId: "strategy-unclaimed",
                    syncedAt: 100,
                    instrument: "token-other",
                    metadata: JSON.stringify({
                        tokenId: "token-other",
                        conditionId: "0xcond2",
                    }),
                },
            ],
        })

        const owned = await getOwnedInstrumentsByAppAccount(
            { db } as never,
            "polymarket",
            "account-1"
        )

        expect(owned).toEqual([
            {
                instrument: "token-yes",
                strategyId: "strategy-yes",
                accountId: "account-1",
            },
            {
                instrument: conditionAlias,
                strategyId: "strategy-yes",
                accountId: "account-1",
            },
            {
                instrument: "token-other",
                strategyId: "strategy-unclaimed",
                accountId: "account-1",
            },
            {
                instrument: "polymarket-condition:0xcond2",
                strategyId: "strategy-unclaimed",
                accountId: "account-1",
            },
        ])
    })
})

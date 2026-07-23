import { describe, expect, it } from "vitest"
import { parseDecisionRecordOutput } from "./decision-record-parser"

describe("parseDecisionRecordOutput", () => {
    it("parses a realistic final output containing both decision artifacts", () => {
        const output = [
            "BTC is holding above the post-news VWAP while perp funding remains contained.",
            "FORECAST | horizon=2h | expected_move=+1.2% | direction=long | invalidation=Break back below 64000 with widening spread. | p=0.63",
            "",
            "I proposed one bounded long setup and will monitor the fill.",
            "```",
            "DECISION_RECORD",
            "detail: buy BTC-USDT-SWAP with a stop below the failed-breakout level",
            "rules_applied:",
            "- \"Treat venue-owned market data as execution truth.\"",
            "- \"If an order is rejected by the risk engine, do not retry with the same parameters.\"",
            "- NOT IN TEXT: Momentum continuation is favored after the failed breakdown",
            "decision: trade",
            "END_DECISION_RECORD",
            "```",
            "",
            "Next run should check whether the breakout still holds.",
        ].join("\n")

        expect(parseDecisionRecordOutput(output)).toEqual({
            forecast: {
                direction: "long",
                p: 0.63,
                expectedMove: "+1.2%",
                horizon: "2h",
                invalidation: "Break back below 64000 with widening spread.",
            },
            decision: "trade",
            detail: "buy BTC-USDT-SWAP with a stop below the failed-breakout level",
            rulesApplied: [
                "Treat venue-owned market data as execution truth.",
                "If an order is rejected by the risk engine, do not retry with the same parameters.",
            ],
            notInText: [
                "Momentum continuation is favored after the failed breakdown",
            ],
        })
    })

    it("keeps parse failure as data when the decision block is missing", () => {
        const output = [
            "FORECAST | direction=neutral | p=0.52 | expected_move=flat | horizon=1h | invalidation=Clean trend break.",
            "No trade because the setup did not qualify.",
        ].join("\n")

        expect(parseDecisionRecordOutput(output)).toEqual({
            forecast: {
                direction: "neutral",
                p: 0.52,
                expectedMove: "flat",
                horizon: "1h",
                invalidation: "Clean trend break.",
            },
            parseError: "DECISION_RECORD block not found",
        })
    })

    it("parses the codex gpt-5.5 fence-info-string decision record shape", () => {
        const output = [
            "FORECAST | direction=short | p=0.57 | expected_move=1.3286 target / ~-0.22% from 1.33148 ask | horizon=NY overlap into 20:45 UTC flat buffer | invalidation=Sustained reclaim above 1.3330/1.3340 or SL 1.3343 invalidates downside continuation.",
            "",
            "Focused callback check: GBPUSD venue quote is 1.33138/1.33148, spread 10 points / ~0.75 bps, ~1.01x baseline.",
            "",
            "```DECISION_RECORD",
            "decision: manage_only",
            "detail: Held existing GBPUSD short 0.09 @ 1.33247 unchanged; prior handoff levels SL 1.3343 / TP 1.3286 remain aligned with thesis.",
            "rules_applied:",
            "- \"Do NOT redo full market research if the structured operational memory above already contains a fresh latest-run handoff.\"",
            "- \"Focus on: checking positions, evaluating if your thesis still holds, adjusting or closing positions, and monitoring fills.\"",
            "- \"allowOverlappingExposure: false\"",
            "- \"Every run, record your view first - direction, probability, expected move, invalidation - then decide.\"",
            "- NOT IN TEXT: Current quote still supports holding because price is below invalidation and spread is normal.",
            "END_DECISION_RECORD",
            "```",
        ].join("\n")

        expect(parseDecisionRecordOutput(output)).toMatchObject({
            forecast: {
                direction: "short",
                p: 0.57,
                expectedMove: "1.3286 target / ~-0.22% from 1.33148 ask",
                horizon: "NY overlap into 20:45 UTC flat buffer",
                invalidation: "Sustained reclaim above 1.3330/1.3340 or SL 1.3343 invalidates downside continuation.",
            },
            decision: "manage_only",
            detail: "Held existing GBPUSD short 0.09 @ 1.33247 unchanged; prior handoff levels SL 1.3343 / TP 1.3286 remain aligned with thesis.",
            rulesApplied: [
                "Do NOT redo full market research if the structured operational memory above already contains a fresh latest-run handoff.",
                "Focus on: checking positions, evaluating if your thesis still holds, adjusting or closing positions, and monitoring fills.",
                "allowOverlappingExposure: false",
                "Every run, record your view first - direction, probability, expected move, invalidation - then decide.",
            ],
            notInText: [
                "Current quote still supports holding because price is below invalidation and spread is normal.",
            ],
        })
    })

    it("uses the last forecast and decision record occurrence", () => {
        const output = [
            "FORECAST | direction=long | p=0.51 | expected_move=stale | horizon=10m | invalidation=Old invalidation.",
            "DECISION_RECORD",
            "decision: no_trade",
            "detail: stale decision",
            "rules_applied:",
            "- \"Old rule\"",
            "END_DECISION_RECORD",
            "",
            "FORECAST | direction=short | p=0.61 | expected_move=-0.8% | horizon=45m | invalidation=Recover above prior high.",
            "DECISION_RECORD",
            "decision: trade",
            "detail: final decision",
            "rules_applied:",
            "- \"Final rule\"",
            "END_DECISION_RECORD",
        ].join("\n")

        expect(parseDecisionRecordOutput(output)).toMatchObject({
            forecast: {
                direction: "short",
                p: 0.61,
                expectedMove: "-0.8%",
                horizon: "45m",
                invalidation: "Recover above prior high.",
            },
            decision: "trade",
            detail: "final decision",
            rulesApplied: [
                "Final rule",
            ],
        })
    })

    it("classifies NOT IN TEXT judgments separately from quoted rules", () => {
        const output = [
            "FORECAST | direction=short | p=0.58 | expected_move=-0.8% | horizon=45m | invalidation=Recover above the prior high.",
            "```",
            "DECISION_RECORD",
            "decision: no_trade",
            "detail: sit out because venue spread is too wide",
            "rules_applied:",
            "- \"Use `propose_close` to reduce or exit existing positions.\"",
            "- NOT IN TEXT: The order book gap is too unstable for a fresh entry",
            "END_DECISION_RECORD",
            "```",
        ].join("\n")

        const record = parseDecisionRecordOutput(output)

        expect(record.rulesApplied).toEqual([
            "Use `propose_close` to reduce or exit existing positions.",
        ])
        expect(record.notInText).toEqual([
            "The order book gap is too unstable for a fresh entry",
        ])
    })
})

import { internalMutation } from "../_generated/server"

function readConfiguredDrawdownPercent(
    value: unknown,
    fallback: number
): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100
        ? value
        : fallback
}

export const simplifyPolicies = internalMutation({
    args: {},
    handler: async (ctx) => {
        const strategies = await ctx.db.query("strategies").collect()
        let migrated = 0

        for (const strategy of strategies) {
            const oldPolicy = strategy.policy as Record<string, unknown>
            let newPolicy: Record<string, unknown>

            switch (strategy.app) {
                case "alpaca-options": {
                    newPolicy = {
                        dryRun: oldPolicy.dryRun ?? true,
                        maxLossPerPlay: oldPolicy.maxLossPerStructure ?? oldPolicy.maxLossPerPlay ?? 500,
                    }
                    break
                }
                case "polymarket": {
                    const maxPositionSize = oldPolicy.maxPositionSize as number | undefined
                    const existingMaxBet = oldPolicy.maxBet as { mode: string; value: number } | undefined
                    newPolicy = {
                        dryRun: oldPolicy.dryRun ?? true,
                        maxBet: existingMaxBet ?? {
                            mode: "fixed",
                            value: maxPositionSize ?? 100,
                        },
                    }
                    break
                }
                case "mt5": {
                    const existingTradingHours = oldPolicy.tradingHours as Record<string, unknown> | undefined
                    const existingSafety = oldPolicy.safety as Record<string, unknown> | undefined
                    newPolicy = {
                        dryRun: oldPolicy.dryRun ?? true,
                        model: typeof oldPolicy.model === "string" ? oldPolicy.model : "",
                        safety: {
                            maxDrawdownDay: readConfiguredDrawdownPercent(
                                existingSafety?.maxDrawdownDay ?? oldPolicy.maxDrawdownDay,
                                3
                            ),
                            maxDrawdownWeek: readConfiguredDrawdownPercent(
                                existingSafety?.maxDrawdownWeek ?? oldPolicy.maxDrawdownWeek,
                                10
                            ),
                            cooldownMinutesAfterDayBreach: typeof existingSafety?.cooldownMinutesAfterDayBreach === "number"
                                ? existingSafety.cooldownMinutesAfterDayBreach
                                : oldPolicy.cooldownMinutesAfterDayBreach ?? 12 * 60,
                            cooldownMinutesAfterWeekBreach: typeof existingSafety?.cooldownMinutesAfterWeekBreach === "number"
                                ? existingSafety.cooldownMinutesAfterWeekBreach
                                : oldPolicy.cooldownMinutesAfterWeekBreach ?? 24 * 60,
                            strategyTimezone: typeof existingSafety?.strategyTimezone === "string"
                                ? existingSafety.strategyTimezone
                                : oldPolicy.strategyTimezone ?? "UTC",
                            sessionFlat: {
                                enabled: typeof existingSafety?.sessionFlat === "object" && existingSafety.sessionFlat !== null &&
                                    typeof (existingSafety.sessionFlat as Record<string, unknown>).enabled === "boolean"
                                    ? (existingSafety.sessionFlat as Record<string, unknown>).enabled as boolean
                                    : true,
                                closeBufferMinutes: typeof existingSafety?.sessionFlat === "object" && existingSafety.sessionFlat !== null &&
                                    typeof (existingSafety.sessionFlat as Record<string, unknown>).closeBufferMinutes === "number"
                                    ? (existingSafety.sessionFlat as Record<string, unknown>).closeBufferMinutes as number
                                    : 15,
                                timezone: typeof existingSafety?.sessionFlat === "object" && existingSafety.sessionFlat !== null &&
                                    typeof (existingSafety.sessionFlat as Record<string, unknown>).timezone === "string"
                                    ? (existingSafety.sessionFlat as Record<string, unknown>).timezone as string
                                    : "UTC",
                            },
                            expectedExternalInstruments: Array.isArray(existingSafety?.expectedExternalInstruments)
                                ? existingSafety.expectedExternalInstruments
                                : [],
                        },
                        maxRiskPercent: oldPolicy.maxRiskPercent ?? 2,
                        tradingHours: existingTradingHours ?? {
                            start: "08:00",
                            end: "16:00",
                            timezone: "UTC",
                        },
                    }
                    break
                }
                default:
                    continue
            }

            await ctx.db.patch(strategy._id, { policy: newPolicy, updatedAt: Date.now() })
            migrated++
        }

        return { migrated, total: strategies.length }
    },
})

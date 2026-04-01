import { internalMutation } from "../_generated/server"

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
                    newPolicy = {
                        dryRun: oldPolicy.dryRun ?? true,
                        maxRiskPercent: oldPolicy.maxRiskPercent ?? 2,
                        tradingHours: existingTradingHours ?? {
                            start: "08:00",
                            end: "16:00",
                            timezone: "UTC",
                        },
                        emergencyFlattenThreshold: oldPolicy.emergencyFlattenThreshold ?? 1000,
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

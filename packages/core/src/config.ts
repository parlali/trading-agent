import { z } from "zod/v4"

export const baseStrategyPolicySchema = z.object({
    dryRun: z.boolean().default(false),
}).passthrough()

export type BaseStrategyPolicy = z.infer<typeof baseStrategyPolicySchema>

export const strategyConfigSchema = z.object({
    app: z.enum(["alpaca-options", "polymarket", "mt5", "binance-futures"]),
    name: z.string().min(1),
    enabled: z.boolean(),
    schedule: z.string().min(1),
    policy: z.record(z.string(), z.unknown()),
    context: z.string(),
})

export type StrategyConfig = z.infer<typeof strategyConfigSchema>

export const alpacaOptionsPolicySchema = baseStrategyPolicySchema.extend({
    maxLossPerPlay: z.number().positive(),
})

export type AlpacaOptionsPolicy = z.infer<typeof alpacaOptionsPolicySchema>

export const polymarketMaxBetSchema = z.object({
    mode: z.enum(["fixed", "percentage"]),
    value: z.number().positive(),
})

export type PolymarketMaxBet = z.infer<typeof polymarketMaxBetSchema>

export const polymarketPolicySchema = baseStrategyPolicySchema.extend({
    maxBet: polymarketMaxBetSchema,
})

export type PolymarketPolicy = z.infer<typeof polymarketPolicySchema>

export const mt5TradingHoursSchema = z.object({
    start: z.string().regex(/^\d{2}:\d{2}$/, "Must be HH:MM format"),
    end: z.string().regex(/^\d{2}:\d{2}$/, "Must be HH:MM format"),
    timezone: z.string().default("UTC"),
})

export type MT5TradingHours = z.infer<typeof mt5TradingHoursSchema>

export const mt5MarketRegionsByInstrumentSchema = z.record(
    z.string().trim().min(1),
    z.array(z.string().trim().min(1)).min(1)
)

export type MT5MarketRegionsByInstrument = z.infer<typeof mt5MarketRegionsByInstrumentSchema>

export const mt5PolicySchema = baseStrategyPolicySchema.extend({
    maxRiskPercent: z.number().positive().max(100),
    minRiskReward: z.number().positive().default(0.5),
    tradingHours: mt5TradingHoursSchema,
    emergencyFlattenThreshold: z.number().positive(),
    marketRegionsByInstrument: mt5MarketRegionsByInstrumentSchema.optional(),
})

export type MT5Policy = z.infer<typeof mt5PolicySchema>

export const binancePolicySchema = baseStrategyPolicySchema.extend({
    allowedInstruments: z.array(z.string().trim().min(1)).min(1),
    maxLeverage: z.number().int().positive().max(5),
    maxRiskPercent: z.number().positive().max(100),
    tradingHours: mt5TradingHoursSchema,
    emergencyFlattenThreshold: z.number().positive(),
    fundingRateThreshold: z.number().nonnegative(),
    requireTakeProfit: z.boolean().default(false),
})

export type BinancePolicy = z.infer<typeof binancePolicySchema>

const policySchemas: Record<string, z.ZodType> = {
    "alpaca-options": alpacaOptionsPolicySchema,
    "polymarket": polymarketPolicySchema,
    "mt5": mt5PolicySchema,
    "binance-futures": binancePolicySchema,
}

export function validateStrategyConfig(raw: unknown): StrategyConfig {
    const config = strategyConfigSchema.parse(raw)

    const policySchema = policySchemas[config.app]
    if (policySchema) {
        policySchema.parse(config.policy)
    }

    return config
}

export const ALPACA_OPTIONS_POLICY_DEFAULTS: AlpacaOptionsPolicy = {
    dryRun: true,
    maxLossPerPlay: 500,
}

export const POLYMARKET_POLICY_DEFAULTS: PolymarketPolicy = {
    dryRun: true,
    maxBet: { mode: "fixed", value: 100 },
}

export const MT5_POLICY_DEFAULTS: MT5Policy = {
    dryRun: true,
    maxRiskPercent: 2,
    minRiskReward: 0.5,
    tradingHours: { start: "08:00", end: "16:00", timezone: "UTC" },
    emergencyFlattenThreshold: 1000,
}

export const BINANCE_POLICY_DEFAULTS: BinancePolicy = {
    dryRun: true,
    allowedInstruments: ["BTCUSDT", "ETHUSDT"],
    maxLeverage: 3,
    maxRiskPercent: 1,
    tradingHours: { start: "00:00", end: "23:59", timezone: "UTC" },
    emergencyFlattenThreshold: 1000,
    fundingRateThreshold: 0.003,
    requireTakeProfit: false,
}

export const POLICY_DEFAULTS: Record<string, Record<string, unknown>> = {
    "alpaca-options": ALPACA_OPTIONS_POLICY_DEFAULTS,
    "polymarket": POLYMARKET_POLICY_DEFAULTS,
    "mt5": MT5_POLICY_DEFAULTS,
    "binance-futures": BINANCE_POLICY_DEFAULTS,
}

export function validatePolicy(app: string, rawPolicy: unknown): Record<string, unknown> {
    const schema = policySchemas[app]
    if (!schema) {
        throw new Error(`No policy schema registered for app: ${app}`)
    }
    return schema.parse(rawPolicy) as Record<string, unknown>
}

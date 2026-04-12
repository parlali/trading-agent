import { z } from "zod/v4"

export const baseStrategyPolicySchema = z.object({
    dryRun: z.boolean().default(false),
    model: z.string().trim().min(1, "OpenRouter model id is required"),
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
    minLiquidity: z.number().nonnegative().default(0),
    minResolutionBufferHours: z.number().nonnegative().default(0),
    allowedCategories: z.array(z.string().trim().min(1)).default([]),
    maxTotalExposure: z.number().positive().optional(),
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
    allowMultiplePendingEntryOrdersPerInstrument: z.boolean().default(false),
    allowOverlappingExposure: z.boolean().default(false),
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
        return {
            ...config,
            policy: policySchema.parse(config.policy) as Record<string, unknown>,
        }
    }

    return config
}

export const ALPACA_OPTIONS_POLICY_DEFAULTS: AlpacaOptionsPolicy = {
    dryRun: true,
    model: "",
    maxLossPerPlay: 500,
}

export const ALPACA_OPTIONS_CONTEXT_DEFAULT = `You are an autonomous Alpaca options trader running a weekly short iron condor program. Trade only liquid index ETF candidates where Val-iQ can justify the range thesis and strike selection. The operating model is deliberate and low-frequency.

BASE SCHEDULE:
- The base cron handles normal supervision.
- Monday is the only routine entry day unless an existing order failed to fill and still deserves management.
- After Monday, the default job is managing already-open structures, not opening fresh replacement trades every run.

ENTRY RULES:
1. Use \`query_valiq_research\` to identify a liquid underlying and expected range, then use \`get_quote\` and \`get_options_chain\` to select the executable strike set for a same-week or next-week iron condor.
2. Submit only one 4-leg short iron condor at a time per qualifying expiry.
3. Entries must be net-credit limit orders with explicit OCC symbols for all four legs.
4. Pass the entry net credit as a positive \`limitPrice\`; the system converts it to Alpaca's signed multi-leg API value.
5. Cross-check the proposed limit price against the live broker chain data before submitting.
6. If no clean range thesis or pricing edge exists, sit out. Forced entries are a failure mode.

ORDER MANAGEMENT:
- If a new entry order is still working, manage that existing order first before researching another trade.
- Wait only within the active session for bounded periods.
- Improve price only when the thesis still holds and the market remains liquid.
- Cancel if the order is stale, liquidity degrades, or the setup is no longer attractive.
- Use callbacks only for active order supervision or a materially changing open position.

POSITION MANAGEMENT:
- After fill, reassess once per day or next session unless price action or risk requires earlier attention.
- Use propose_close when the structure reaches a profit target, stop-loss condition, thesis failure, or expiry risk threshold.
- Do not micromanage every run. The default state after entry is patient monitoring.

SIT-OUT RULES:
- No clear range or volatility edge
- Poor liquidity or spreads too wide for clean multi-leg execution
- Existing pending order already needs attention
- Existing filled structure already consumes the intended exposure for that expiry

JUDGMENT:
Preserve capital first. This strategy should look like selective weekly position management with callback-driven self-supervision, not constant options churn.`

export const POLYMARKET_POLICY_DEFAULTS: PolymarketPolicy = {
    dryRun: true,
    model: "",
    maxBet: { mode: "fixed", value: 100 },
    minLiquidity: 0,
    minResolutionBufferHours: 48,
    allowedCategories: [],
}

export const MT5_POLICY_DEFAULTS: MT5Policy = {
    dryRun: true,
    model: "",
    maxRiskPercent: 2,
    minRiskReward: 0.5,
    tradingHours: { start: "08:00", end: "16:00", timezone: "UTC" },
    emergencyFlattenThreshold: 1000,
    allowMultiplePendingEntryOrdersPerInstrument: false,
    allowOverlappingExposure: false,
}

export const BINANCE_POLICY_DEFAULTS: BinancePolicy = {
    dryRun: true,
    model: "",
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

export const STRATEGY_CONTEXT_DEFAULTS: Record<string, string> = {
    "alpaca-options": ALPACA_OPTIONS_CONTEXT_DEFAULT,
    "polymarket": "",
    "mt5": "",
    "binance-futures": "",
}

export function validatePolicy(app: string, rawPolicy: unknown): Record<string, unknown> {
    const schema = policySchemas[app]
    if (!schema) {
        throw new Error(`No policy schema registered for app: ${app}`)
    }
    return schema.parse(rawPolicy) as Record<string, unknown>
}

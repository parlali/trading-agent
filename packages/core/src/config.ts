import { z } from "zod/v4"
import { readFiniteNumber, readTrimmedString } from "./value-readers"

type SessionFlatDefaults = {
    enabled: boolean
    closeBufferMinutes: number
    timezone: string
}

type StrategySafetyDefaults = {
    maxDrawdownDay: number | undefined
    maxDrawdownWeek: number | undefined
    cooldownMinutesAfterDayBreach: number
    cooldownMinutesAfterWeekBreach: number
    strategyTimezone: string
    sessionFlat: SessionFlatDefaults
    account: { allocationPercent: number } | undefined
    expectedExternalInstruments: string[]
    pendingEntryTtlMinutes: number | undefined
}

const DEFAULT_OPENROUTER_LLM = {
    provider: "openrouter" as const,
    model: "openai/gpt-4.1-mini",
}

type StrategySafetyDefaultOverrides = Partial<Omit<
    StrategySafetyDefaults,
    "sessionFlat" | "expectedExternalInstruments"
>> & {
    sessionFlat?: Partial<SessionFlatDefaults>
    expectedExternalInstruments?: string[]
}

const DEFAULT_SESSION_FLAT_POLICY: SessionFlatDefaults = {
    enabled: false,
    closeBufferMinutes: 15,
    timezone: "UTC",
}

function createStrategySafetyDefaults(overrides: StrategySafetyDefaultOverrides = {}): StrategySafetyDefaults {
    return {
        maxDrawdownDay: undefined,
        maxDrawdownWeek: undefined,
        cooldownMinutesAfterDayBreach: 12 * 60,
        cooldownMinutesAfterWeekBreach: 24 * 60,
        strategyTimezone: "UTC",
        account: undefined,
        pendingEntryTtlMinutes: undefined,
        ...overrides,
        sessionFlat: {
            ...DEFAULT_SESSION_FLAT_POLICY,
            ...overrides.sessionFlat,
        },
        expectedExternalInstruments: overrides.expectedExternalInstruments ?? [],
    }
}

function createBasePolicyDefaults(overrides?: StrategySafetyDefaultOverrides) {
    return {
        dryRun: true,
        llm: {
            ...DEFAULT_OPENROUTER_LLM,
        },
        safety: createStrategySafetyDefaults(overrides),
    }
}

export const openRouterReasoningConfigSchema = z.object({
    effort: z.enum(["low", "medium", "high"]).default("medium"),
    exclude: z.boolean().default(true),
})

export const openRouterLlmProviderSchema = z.object({
    provider: z.literal("openrouter"),
    model: z.string().trim().min(1, "OpenRouter model id is required"),
    reasoning: openRouterReasoningConfigSchema.optional(),
    baseUrl: z.string().trim().min(1).optional(),
})

export const codexLlmProviderSchema = z.object({
    provider: z.literal("codex"),
    model: z.string().trim().min(1, "Codex model id is required"),
    effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).optional(),
    summary: z.enum(["auto", "concise", "detailed", "none"]).optional(),
    serviceTier: z.string().trim().min(1).optional(),
    authMode: z.enum(["chatgpt", "access-token", "api-key"]),
    codexBin: z.string().trim().min(1).optional(),
})

export const llmProviderSchema = z.discriminatedUnion("provider", [
    openRouterLlmProviderSchema,
    codexLlmProviderSchema,
])

export type OpenRouterLlmProviderConfig = z.infer<typeof openRouterLlmProviderSchema>
export type CodexLlmProviderConfig = z.infer<typeof codexLlmProviderSchema>
export type StrategyLlmConfig = z.infer<typeof llmProviderSchema>

export const baseStrategyPolicySchema = z.object({
    dryRun: z.boolean().default(false),
    llm: llmProviderSchema,
    safety: z.object({
        maxDrawdownDay: z.number().positive().max(100).optional(),
        maxDrawdownWeek: z.number().positive().max(100).optional(),
        cooldownMinutesAfterDayBreach: z.number().int().nonnegative().default(12 * 60),
        cooldownMinutesAfterWeekBreach: z.number().int().nonnegative().default(24 * 60),
        strategyTimezone: z.string().default("UTC"),
        sessionFlat: z.object({
            enabled: z.boolean().default(false),
            closeBufferMinutes: z.number().int().min(1).max(240).default(15),
            timezone: z.string().default("UTC"),
        }).default({
            ...DEFAULT_SESSION_FLAT_POLICY,
        }),
        account: z.object({
            allocationPercent: z.number().positive().max(100),
        }).optional(),
        expectedExternalInstruments: z.array(z.string().trim().min(1)).default([]),
        pendingEntryTtlMinutes: z.number().int().positive().max(7 * 24 * 60).optional(),
    }).default(createStrategySafetyDefaults()),
}).passthrough()

export type BaseStrategyPolicy = z.infer<typeof baseStrategyPolicySchema>

export function resolveStrategyLlmConfig(policy: Record<string, unknown>): StrategyLlmConfig {
    assertNoLegacyLlmPolicyFields(policy)
    return llmProviderSchema.parse(policy.llm)
}

export function migrateLegacyStrategyLlmPolicy(policy: Record<string, unknown>): Record<string, unknown> {
    if ("llm" in policy) {
        assertNoLegacyLlmPolicyFields(policy)
        return {
            ...policy,
            llm: llmProviderSchema.parse(policy.llm),
        }
    }

    const model = policy.model
    if (typeof model !== "string" || model.trim().length === 0) {
        throw new Error("Cannot migrate strategy policy without a non-empty legacy model")
    }

    const reasoning = readOpenRouterReasoningPolicy(policy.reasoning)
    const { model: _model, reasoning: _reasoning, ...rest } = policy

    return {
        ...rest,
        llm: openRouterLlmProviderSchema.parse({
            provider: "openrouter",
            model,
            reasoning,
        }),
    }
}

function assertNoLegacyLlmPolicyFields(policy: Record<string, unknown>): void {
    const legacyFields = []
    if ("model" in policy) {
        legacyFields.push("policy.model")
    }
    if ("reasoning" in policy) {
        legacyFields.push("policy.reasoning")
    }

    if (legacyFields.length > 0) {
        const suffix = "llm" in policy
            ? "mixed legacy and canonical LLM policy is ambiguous"
            : "legacy LLM policy must be migrated to policy.llm"
        throw new Error(`${legacyFields.join(", ")} found: ${suffix}`)
    }
}

function readOpenRouterReasoningPolicy(value: unknown): z.infer<typeof openRouterReasoningConfigSchema> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined
    }

    return openRouterReasoningConfigSchema.parse(value)
}

export interface ConfiguredStrategySafetyPolicy {
    maxDrawdownDay?: number
    maxDrawdownWeek?: number
    cooldownMinutesAfterDayBreach: number
    cooldownMinutesAfterWeekBreach: number
    strategyTimezone: string
}

export interface RuntimeStrategySafetyPolicy {
    maxDrawdownDay?: number
    maxDrawdownWeek?: number
    cooldownMinutesAfterDayBreach: number
    cooldownMinutesAfterWeekBreach: number
    strategyTimezone: string
}

function readPositivePercentage(value: unknown): number | undefined {
    const numeric = readFiniteNumber(value)
    if (numeric === undefined || numeric <= 0 || numeric > 100) {
        return undefined
    }

    return numeric
}

function roundCurrencyAmount(value: number): number {
    return Number(value.toFixed(2))
}

function resolveAbsoluteDrawdownLimit(
    percentLimit: number | undefined,
    accountBalance: number | undefined,
    label: "day" | "week"
): number | undefined {
    if (percentLimit === undefined) {
        return undefined
    }

    if (accountBalance === undefined || !Number.isFinite(accountBalance) || accountBalance <= 0) {
        throw new Error(`Cannot resolve ${label} max drawdown percentage without a positive account balance`)
    }

    return roundCurrencyAmount(accountBalance * (percentLimit / 100))
}

export function readConfiguredStrategySafetyPolicy(policy: Record<string, unknown>): ConfiguredStrategySafetyPolicy {
    const safety = (policy.safety ?? {}) as Record<string, unknown>

    return {
        maxDrawdownDay: readPositivePercentage(safety.maxDrawdownDay),
        maxDrawdownWeek: readPositivePercentage(safety.maxDrawdownWeek),
        cooldownMinutesAfterDayBreach: readFiniteNumber(safety.cooldownMinutesAfterDayBreach) ?? 12 * 60,
        cooldownMinutesAfterWeekBreach: readFiniteNumber(safety.cooldownMinutesAfterWeekBreach) ?? 24 * 60,
        strategyTimezone: readTrimmedString(safety.strategyTimezone) ?? "UTC",
    }
}

export function resolveRuntimeStrategySafetyPolicy(args: {
    policy: ConfiguredStrategySafetyPolicy
    accountBalance?: number
}): RuntimeStrategySafetyPolicy {
    return {
        maxDrawdownDay: resolveAbsoluteDrawdownLimit(args.policy.maxDrawdownDay, args.accountBalance, "day"),
        maxDrawdownWeek: resolveAbsoluteDrawdownLimit(args.policy.maxDrawdownWeek, args.accountBalance, "week"),
        cooldownMinutesAfterDayBreach: args.policy.cooldownMinutesAfterDayBreach,
        cooldownMinutesAfterWeekBreach: args.policy.cooldownMinutesAfterWeekBreach,
        strategyTimezone: args.policy.strategyTimezone,
    }
}

export const strategyConfigSchema = z.object({
    app: z.enum(["alpaca-options", "polymarket", "mt5", "okx-swap"]),
    accountId: z.string().trim().min(1),
    name: z.string().min(1),
    enabled: z.boolean(),
    schedule: z.string().min(1),
    policy: z.record(z.string(), z.unknown()),
    context: z.string(),
})

export type StrategyConfig = z.infer<typeof strategyConfigSchema>

export const accountConfigSchema = z.object({
    app: strategyConfigSchema.shape.app,
    accountId: z.string().trim().min(1),
    label: z.string().trim().min(1),
    credentialEnvPrefix: z.string().trim().min(1),
    status: z.enum(["active", "disabled"]).default("active"),
    notes: z.string().trim().optional(),
})

export type AccountConfig = z.infer<typeof accountConfigSchema>

export function validateAccountConfig(raw: unknown): AccountConfig {
    return accountConfigSchema.parse(raw)
}

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
    marketRegionsByInstrument: mt5MarketRegionsByInstrumentSchema.optional(),
    allowMultiplePendingEntryOrdersPerInstrument: z.boolean().default(false),
    allowOverlappingExposure: z.boolean().default(false),
})

export type MT5Policy = z.infer<typeof mt5PolicySchema>

export const okxPolicySchema = baseStrategyPolicySchema.extend({
    allowedInstruments: z.array(z.string().trim().min(1)).min(1),
    maxLeverage: z.number().int().positive().max(5),
    maxRiskPercent: z.number().positive().max(100),
    tradingHours: mt5TradingHoursSchema,
    fundingRateThreshold: z.number().nonnegative(),
    requireTakeProfit: z.boolean().default(false),
})

export type OKXPolicy = z.infer<typeof okxPolicySchema>

const policySchemas: Record<string, z.ZodType> = {
    "alpaca-options": alpacaOptionsPolicySchema,
    "polymarket": polymarketPolicySchema,
    "mt5": mt5PolicySchema,
    "okx-swap": okxPolicySchema,
}

export function validateStrategyConfig(raw: unknown): StrategyConfig {
    const config = strategyConfigSchema.parse(raw)

    const policySchema = policySchemas[config.app]
    if (policySchema) {
        assertNoLegacyLlmPolicyFields(config.policy)
        return {
            ...config,
            policy: policySchema.parse(config.policy) as Record<string, unknown>,
        }
    }

    return config
}

export const ALPACA_OPTIONS_POLICY_DEFAULTS: AlpacaOptionsPolicy = {
    ...createBasePolicyDefaults(),
    maxLossPerPlay: 500,
}

export const ALPACA_OPTIONS_CONTEXT_DEFAULT = `You are an autonomous Alpaca options trader running a weekly short premium program with iron condors and one-sided credit verticals. Trade only liquid index ETF candidates where configured research tools can justify the range thesis and strike selection. The operating model is deliberate and low-frequency.

BASE SCHEDULE:
- The base cron handles normal supervision.
- Monday is the only routine entry day unless an existing order failed to fill and still deserves management.
- After Monday, the default job is managing already-open structures, not opening fresh replacement trades every run.

ENTRY RULES:
1. Use configured MCP research tools to identify a liquid underlying and directional or range thesis, then use \`get_quote\` and \`get_options_chain\` to select strikes for a same-week or next-week credit structure.
2. Submit only one active credit structure per qualifying expiry unless policy explicitly allows overlap.
3. Entries must be net-credit limit orders with explicit OCC symbols for all legs.
4. Supported structures are 2-leg one-sided credit verticals (bull put or bear call) and 4-leg iron condors.
5. Pass the entry net credit as a positive \`limitPrice\`; the system converts it to Alpaca's signed multi-leg API value.
6. Cross-check the proposed limit price against the live broker chain data before submitting.
7. If no clean thesis or pricing edge exists, sit out. Forced entries are a failure mode.

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
- Poor liquidity or execution cost too wide for clean multi-leg execution
- Existing pending order already needs attention
- Existing filled structure already consumes the intended exposure for that expiry

JUDGMENT:
Preserve capital first. This strategy should look like selective weekly position management with callback-driven self-supervision, not constant options churn.`

export const POLYMARKET_POLICY_DEFAULTS: PolymarketPolicy = {
    ...createBasePolicyDefaults(),
    maxBet: { mode: "fixed", value: 100 },
    minLiquidity: 0,
    minResolutionBufferHours: 48,
    allowedCategories: [],
}

export const MT5_POLICY_DEFAULTS: MT5Policy = {
    ...createBasePolicyDefaults({
        maxDrawdownDay: 3,
        maxDrawdownWeek: 10,
        sessionFlat: {
            enabled: true,
        },
        pendingEntryTtlMinutes: 120,
    }),
    maxRiskPercent: 2,
    minRiskReward: 0.5,
    tradingHours: { start: "08:00", end: "16:00", timezone: "UTC" },
    allowMultiplePendingEntryOrdersPerInstrument: false,
    allowOverlappingExposure: false,
}

export const OKX_POLICY_DEFAULTS: OKXPolicy = {
    ...createBasePolicyDefaults({
        maxDrawdownDay: 3,
        maxDrawdownWeek: 10,
        sessionFlat: {
            enabled: true,
        },
        pendingEntryTtlMinutes: 120,
    }),
    allowedInstruments: ["BTC-USDT-SWAP", "ETH-USDT-SWAP"],
    maxLeverage: 3,
    maxRiskPercent: 1,
    tradingHours: { start: "00:00", end: "23:59", timezone: "UTC" },
    fundingRateThreshold: 0.003,
    requireTakeProfit: false,
}

export const POLICY_DEFAULTS: Record<string, Record<string, unknown>> = {
    "alpaca-options": ALPACA_OPTIONS_POLICY_DEFAULTS,
    "polymarket": POLYMARKET_POLICY_DEFAULTS,
    "mt5": MT5_POLICY_DEFAULTS,
    "okx-swap": OKX_POLICY_DEFAULTS,
}

export const STRATEGY_CONTEXT_DEFAULTS: Record<string, string> = {
    "alpaca-options": ALPACA_OPTIONS_CONTEXT_DEFAULT,
    "polymarket": "",
    "mt5": "",
    "okx-swap": "",
}

export function validatePolicy(app: string, rawPolicy: unknown): Record<string, unknown> {
    const schema = policySchemas[app]
    if (!schema) {
        throw new Error(`No policy schema registered for app: ${app}`)
    }
    if (!rawPolicy || typeof rawPolicy !== "object" || Array.isArray(rawPolicy)) {
        throw new Error("Strategy policy must be an object")
    }
    assertNoLegacyLlmPolicyFields(rawPolicy as Record<string, unknown>)
    return schema.parse(rawPolicy) as Record<string, unknown>
}

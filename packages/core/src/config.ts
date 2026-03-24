import { z } from "zod/v4"

export const baseStrategyPolicySchema = z.object({
    dryRun: z.boolean().default(false),
    balanceFloor: z.number().optional(),
    maxLossPerTrade: z.number().optional(),
    maxTotalExposure: z.number().optional(),
})

export type BaseStrategyPolicy = z.infer<typeof baseStrategyPolicySchema>

export const strategyConfigSchema = z.object({
    app: z.enum(["alpaca-options", "polymarket", "mt5"]),
    name: z.string().min(1),
    enabled: z.boolean(),
    schedule: z.string().min(1),
    policy: z.record(z.string(), z.unknown()),
    context: z.string(),
})

export type StrategyConfig = z.infer<typeof strategyConfigSchema>

export const alpacaOptionsPolicySchema = baseStrategyPolicySchema.extend({
    broker: z.string().min(1),
    accountId: z.string().min(1),
    maxLossPerStructure: z.number().positive(),
    maxConcurrentStructures: z.number().int().positive(),
    allowedUnderlyings: z.array(z.string().min(1)).min(1),
})

export type AlpacaOptionsPolicy = z.infer<typeof alpacaOptionsPolicySchema>

export const polymarketPolicySchema = baseStrategyPolicySchema.extend({
    credentialsRef: z.string().min(1),
    maxPositionSize: z.number().positive(),
    maxTotalExposure: z.number().positive(),
    allowedCategories: z.array(z.string()).optional(),
    minLiquidity: z.number().nonnegative().optional(),
})

export type PolymarketPolicy = z.infer<typeof polymarketPolicySchema>

export const mt5TradingHoursSchema = z.object({
    start: z.string().regex(/^\d{2}:\d{2}$/, "Must be HH:MM format"),
    end: z.string().regex(/^\d{2}:\d{2}$/, "Must be HH:MM format"),
    timezone: z.string().default("UTC"),
})

export type MT5TradingHours = z.infer<typeof mt5TradingHoursSchema>

export const mt5PolicySchema = baseStrategyPolicySchema.extend({
    credentialsRef: z.string().min(1),
    maxDailyLoss: z.number().positive(),
    maxConcurrentPositions: z.number().int().positive(),
    maxLeverage: z.number().positive(),
    allowedInstruments: z.array(z.string().min(1)).min(1),
    tradingHours: mt5TradingHoursSchema,
    emergencyFlattenThreshold: z.number().positive(),
})

export type MT5Policy = z.infer<typeof mt5PolicySchema>

const policySchemas: Record<string, z.ZodType> = {
    "alpaca-options": alpacaOptionsPolicySchema,
    "polymarket": polymarketPolicySchema,
    "mt5": mt5PolicySchema,
}

export function validateStrategyConfig(raw: unknown): StrategyConfig {
    const config = strategyConfigSchema.parse(raw)

    const policySchema = policySchemas[config.app]
    if (policySchema) {
        policySchema.parse(config.policy)
    }

    return config
}

export function validatePolicy(app: string, rawPolicy: unknown): Record<string, unknown> {
    const schema = policySchemas[app]
    if (!schema) {
        throw new Error(`No policy schema registered for app: ${app}`)
    }
    return schema.parse(rawPolicy) as Record<string, unknown>
}

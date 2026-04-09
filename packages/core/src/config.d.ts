import { z } from "zod/v4";
export declare const baseStrategyPolicySchema: z.ZodObject<{
    dryRun: z.ZodDefault<z.ZodBoolean>;
    model: z.ZodString;
}, z.core.$loose>;
export type BaseStrategyPolicy = z.infer<typeof baseStrategyPolicySchema>;
export declare const strategyConfigSchema: z.ZodObject<{
    app: z.ZodEnum<{
        "alpaca-options": "alpaca-options";
        polymarket: "polymarket";
        mt5: "mt5";
        "binance-futures": "binance-futures";
    }>;
    name: z.ZodString;
    enabled: z.ZodBoolean;
    schedule: z.ZodString;
    policy: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    context: z.ZodString;
}, z.core.$strip>;
export type StrategyConfig = z.infer<typeof strategyConfigSchema>;
export declare const alpacaOptionsPolicySchema: z.ZodObject<{
    dryRun: z.ZodDefault<z.ZodBoolean>;
    model: z.ZodString;
    maxLossPerPlay: z.ZodNumber;
}, z.core.$loose>;
export type AlpacaOptionsPolicy = z.infer<typeof alpacaOptionsPolicySchema>;
export declare const polymarketMaxBetSchema: z.ZodObject<{
    mode: z.ZodEnum<{
        fixed: "fixed";
        percentage: "percentage";
    }>;
    value: z.ZodNumber;
}, z.core.$strip>;
export type PolymarketMaxBet = z.infer<typeof polymarketMaxBetSchema>;
export declare const polymarketPolicySchema: z.ZodObject<{
    dryRun: z.ZodDefault<z.ZodBoolean>;
    model: z.ZodString;
    maxBet: z.ZodObject<{
        mode: z.ZodEnum<{
            fixed: "fixed";
            percentage: "percentage";
        }>;
        value: z.ZodNumber;
    }, z.core.$strip>;
}, z.core.$loose>;
export type PolymarketPolicy = z.infer<typeof polymarketPolicySchema>;
export declare const mt5TradingHoursSchema: z.ZodObject<{
    start: z.ZodString;
    end: z.ZodString;
    timezone: z.ZodDefault<z.ZodString>;
}, z.core.$strip>;
export type MT5TradingHours = z.infer<typeof mt5TradingHoursSchema>;
export declare const mt5MarketRegionsByInstrumentSchema: z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString>>;
export type MT5MarketRegionsByInstrument = z.infer<typeof mt5MarketRegionsByInstrumentSchema>;
export declare const mt5PolicySchema: z.ZodObject<{
    dryRun: z.ZodDefault<z.ZodBoolean>;
    model: z.ZodString;
    maxRiskPercent: z.ZodNumber;
    minRiskReward: z.ZodDefault<z.ZodNumber>;
    tradingHours: z.ZodObject<{
        start: z.ZodString;
        end: z.ZodString;
        timezone: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>;
    emergencyFlattenThreshold: z.ZodNumber;
    marketRegionsByInstrument: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString>>>;
    allowMultiplePendingEntryOrdersPerInstrument: z.ZodDefault<z.ZodBoolean>;
    allowOverlappingExposure: z.ZodDefault<z.ZodBoolean>;
}, z.core.$loose>;
export type MT5Policy = z.infer<typeof mt5PolicySchema>;
export declare const binancePolicySchema: z.ZodObject<{
    dryRun: z.ZodDefault<z.ZodBoolean>;
    model: z.ZodString;
    allowedInstruments: z.ZodArray<z.ZodString>;
    maxLeverage: z.ZodNumber;
    maxRiskPercent: z.ZodNumber;
    tradingHours: z.ZodObject<{
        start: z.ZodString;
        end: z.ZodString;
        timezone: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>;
    emergencyFlattenThreshold: z.ZodNumber;
    fundingRateThreshold: z.ZodNumber;
    requireTakeProfit: z.ZodDefault<z.ZodBoolean>;
}, z.core.$loose>;
export type BinancePolicy = z.infer<typeof binancePolicySchema>;
export declare function validateStrategyConfig(raw: unknown): StrategyConfig;
export declare const ALPACA_OPTIONS_POLICY_DEFAULTS: AlpacaOptionsPolicy;
export declare const ALPACA_OPTIONS_CONTEXT_DEFAULT = "You are an autonomous Alpaca options trader running a weekly short iron condor program. Trade only liquid index ETF candidates where Val-iQ can justify the range thesis and strike selection. The operating model is deliberate and low-frequency.\n\nBASE SCHEDULE:\n- The base cron handles normal supervision.\n- Monday is the only routine entry day unless an existing order failed to fill and still deserves management.\n- After Monday, the default job is managing already-open structures, not opening fresh replacement trades every run.\n\nENTRY RULES:\n1. Use `query_valiq_research` to identify a liquid underlying and expected range, then use `get_quote` and `get_options_chain` to select the executable strike set for a same-week or next-week iron condor.\n2. Submit only one 4-leg short iron condor at a time per qualifying expiry.\n3. Entries must be net-credit limit orders with explicit OCC symbols for all four legs.\n4. Cross-check the proposed limit price against the live broker chain data before submitting.\n5. If no clean range thesis or pricing edge exists, sit out. Forced entries are a failure mode.\n\nORDER MANAGEMENT:\n- If a new entry order is still working, manage that existing order first before researching another trade.\n- Wait only within the active session for bounded periods.\n- Improve price only when the thesis still holds and the market remains liquid.\n- Cancel if the order is stale, liquidity degrades, or the setup is no longer attractive.\n- Use callbacks only for active order supervision or a materially changing open position.\n\nPOSITION MANAGEMENT:\n- After fill, reassess once per day or next session unless price action or risk requires earlier attention.\n- Use propose_close when the structure reaches a profit target, stop-loss condition, thesis failure, or expiry risk threshold.\n- Do not micromanage every run. The default state after entry is patient monitoring.\n\nSIT-OUT RULES:\n- No clear range or volatility edge\n- Poor liquidity or spreads too wide for clean multi-leg execution\n- Existing pending order already needs attention\n- Existing filled structure already consumes the intended exposure for that expiry\n\nJUDGMENT:\nPreserve capital first. This strategy should look like selective weekly position management with callback-driven self-supervision, not constant options churn.";
export declare const POLYMARKET_POLICY_DEFAULTS: PolymarketPolicy;
export declare const MT5_POLICY_DEFAULTS: MT5Policy;
export declare const BINANCE_POLICY_DEFAULTS: BinancePolicy;
export declare const POLICY_DEFAULTS: Record<string, Record<string, unknown>>;
export declare const STRATEGY_CONTEXT_DEFAULTS: Record<string, string>;
export declare function validatePolicy(app: string, rawPolicy: unknown): Record<string, unknown>;
//# sourceMappingURL=config.d.ts.map
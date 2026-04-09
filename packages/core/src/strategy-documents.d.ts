import { z } from "zod/v4";
import { type StrategyConfig } from "./config";
export declare const STRATEGY_MARKDOWN_VERSION = 1;
export declare const STRATEGY_MARKDOWN_VERSION_MARKER = "<!-- strategy-doc:v1 -->";
declare const strategyMarkdownConfigSchema: z.ZodObject<{
    app: z.ZodEnum<{
        "alpaca-options": "alpaca-options";
        polymarket: "polymarket";
        mt5: "mt5";
        "binance-futures": "binance-futures";
    }>;
    enabled: z.ZodBoolean;
    schedule: z.ZodString;
    policy: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, z.core.$strip>;
export type StrategyMarkdownConfig = z.infer<typeof strategyMarkdownConfigSchema>;
export interface StrategyMarkdownDocument {
    version: typeof STRATEGY_MARKDOWN_VERSION;
    strategies: StrategyConfig[];
}
export declare function parseStrategyMarkdownDocument(markdown: string): StrategyMarkdownDocument;
export {};
//# sourceMappingURL=strategy-documents.d.ts.map
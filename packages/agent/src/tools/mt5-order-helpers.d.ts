import { z } from "zod";
import { type ExecutionErrorDetail, type ExecutionPipeline, type MT5Policy, type PriceVerification } from "@valiq-trading/core";
import type { MT5VenueAdapter } from "@valiq-trading/mt5";
export declare const mt5OrderParamsSchema: z.ZodObject<{
    instrument: z.ZodString;
    side: z.ZodEnum<{
        buy: "buy";
        sell: "sell";
    }>;
    orderType: z.ZodEnum<{
        market: "market";
        limit: "limit";
        stop: "stop";
        stop_limit: "stop_limit";
    }>;
    limitPrice: z.ZodPipe<z.ZodTransform<{} | undefined, unknown>, z.ZodOptional<z.ZodNumber>>;
    stopPrice: z.ZodPipe<z.ZodTransform<{} | undefined, unknown>, z.ZodOptional<z.ZodNumber>>;
    stopLoss: z.ZodNumber;
    takeProfit: z.ZodPipe<z.ZodTransform<{} | undefined, unknown>, z.ZodOptional<z.ZodNumber>>;
    riskRewardRatio: z.ZodPipe<z.ZodPipe<z.ZodTransform<{} | undefined, unknown>, z.ZodOptional<z.ZodNumber>>, z.ZodOptional<z.ZodNumber>>;
    timeInForce: z.ZodDefault<z.ZodEnum<{
        day: "day";
        gtc: "gtc";
        ioc: "ioc";
        fok: "fok";
    }>>;
    reason: z.ZodString;
}, z.core.$strip>;
export type MT5OrderParams = z.infer<typeof mt5OrderParamsSchema>;
export declare const mt5OrderJsonSchema: {
    readonly type: "object";
    readonly properties: {
        readonly instrument: {
            readonly type: "string";
            readonly description: "The instrument/ticker symbol (e.g. EURUSD, XAUUSD)";
        };
        readonly side: {
            readonly type: "string";
            readonly enum: readonly ["buy", "sell"];
        };
        readonly orderType: {
            readonly type: "string";
            readonly enum: readonly ["market", "limit", "stop", "stop_limit"];
        };
        readonly limitPrice: {
            readonly type: "number";
            readonly description: "Entry price for limit/stop_limit orders";
        };
        readonly stopPrice: {
            readonly type: "number";
            readonly description: "Trigger price for stop/stop_limit orders";
        };
        readonly stopLoss: {
            readonly type: "number";
            readonly description: "Absolute price level for stop-loss. Always required.";
        };
        readonly takeProfit: {
            readonly type: "number";
            readonly description: "Absolute price level for take-profit. Provide this OR riskRewardRatio, not both.";
        };
        readonly riskRewardRatio: {
            readonly type: "number";
            readonly description: "Risk-reward ratio (e.g. 2.0 means TP distance is 2x SL distance). Provide this OR takeProfit, not both.";
        };
        readonly timeInForce: {
            readonly type: "string";
            readonly enum: readonly ["day", "gtc", "ioc", "fok"];
            readonly default: "gtc";
        };
        readonly reason: {
            readonly type: "string";
            readonly description: "Why this trade is being taken";
        };
    };
    readonly required: readonly ["instrument", "side", "orderType", "stopLoss", "reason"];
    readonly oneOf: readonly [{
        readonly required: readonly ["takeProfit"];
    }, {
        readonly required: readonly ["riskRewardRatio"];
    }];
};
export interface MT5OrderResult {
    orderId: string;
    status: string;
    filledQuantity: number;
    fillPrice?: number;
    error?: string;
    errorDetail?: ExecutionErrorDetail;
    priceVerification?: PriceVerification;
    computed?: {
        entryPrice: number;
        stopLoss: number;
        takeProfit: number;
        volume: number;
        riskAmount: number;
        riskPercent: number;
        impliedRR: number;
    };
    riskValidation: {
        allowed: boolean;
        reason?: string;
    };
}
export declare function prepareMT5Order(params: MT5OrderParams, pipeline: ExecutionPipeline, venue: MT5VenueAdapter, policy: MT5Policy, action: "entry" | "adjustment"): Promise<MT5OrderResult>;
//# sourceMappingURL=mt5-order-helpers.d.ts.map
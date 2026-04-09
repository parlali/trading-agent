import { z } from "zod";
import type { BinanceVenueAdapter } from "@valiq-trading/binance";
import { type BinancePolicy, type ExecutionErrorDetail, type ExecutionPipeline, type PriceVerification } from "@valiq-trading/core";
export declare const binanceOrderParamsSchema: z.ZodObject<{
    instrument: z.ZodString;
    side: z.ZodEnum<{
        buy: "buy";
        sell: "sell";
    }>;
    leverage: z.ZodOptional<z.ZodNumber>;
    orderType: z.ZodDefault<z.ZodEnum<{
        market: "market";
        limit: "limit";
        stop: "stop";
        stop_limit: "stop_limit";
    }>>;
    limitPrice: z.ZodOptional<z.ZodNumber>;
    stopPrice: z.ZodOptional<z.ZodNumber>;
    stopLoss: z.ZodNumber;
    takeProfit: z.ZodOptional<z.ZodNumber>;
    riskRewardRatio: z.ZodOptional<z.ZodNumber>;
    timeInForce: z.ZodDefault<z.ZodEnum<{
        day: "day";
        gtc: "gtc";
        ioc: "ioc";
        fok: "fok";
    }>>;
    reason: z.ZodString;
}, z.core.$strip>;
export type BinanceOrderParams = z.infer<typeof binanceOrderParamsSchema>;
export declare const binanceOrderJsonSchema: {
    readonly type: "object";
    readonly properties: {
        readonly instrument: {
            readonly type: "string";
            readonly description: "Perpetual symbol, e.g. BTCUSDT or ETHUSDT";
        };
        readonly side: {
            readonly type: "string";
            readonly enum: readonly ["buy", "sell"];
        };
        readonly leverage: {
            readonly type: "number";
            readonly description: "Leverage to apply for this trade. Must be <= policy maxLeverage.";
        };
        readonly orderType: {
            readonly type: "string";
            readonly enum: readonly ["market", "limit", "stop", "stop_limit"];
            readonly default: "market";
        };
        readonly limitPrice: {
            readonly type: "number";
            readonly description: "Required for limit/stop_limit entries";
        };
        readonly stopPrice: {
            readonly type: "number";
            readonly description: "Required for stop/stop_limit entries";
        };
        readonly stopLoss: {
            readonly type: "number";
            readonly description: "Absolute stop-loss price. Always required.";
        };
        readonly takeProfit: {
            readonly type: "number";
            readonly description: "Absolute take-profit price. Provide this OR riskRewardRatio.";
        };
        readonly riskRewardRatio: {
            readonly type: "number";
            readonly description: "Risk-reward ratio used to derive takeProfit. Provide this OR takeProfit.";
        };
        readonly timeInForce: {
            readonly type: "string";
            readonly enum: readonly ["day", "gtc", "ioc", "fok"];
            readonly default: "gtc";
        };
        readonly reason: {
            readonly type: "string";
            readonly description: "Trade rationale";
        };
    };
    readonly required: readonly ["instrument", "side", "stopLoss", "reason"];
};
export interface BinanceOrderResult {
    orderId: string;
    status: string;
    filledQuantity: number;
    fillPrice?: number;
    error?: string;
    errorDetail?: ExecutionErrorDetail;
    priceVerification?: PriceVerification;
    protectionOrders?: {
        cancelledOrderIds: string[];
        createdOrderIds: string[];
        error?: string;
    };
    computed?: {
        entryPrice: number;
        stopLoss: number;
        takeProfit: number;
        quantity: number;
        leverage: number;
        riskAmount: number;
        riskPercent: number;
        impliedRR: number;
        fundingRate?: number;
    };
    riskValidation: {
        allowed: boolean;
        reason?: string;
    };
}
export declare function prepareBinanceOrder(params: BinanceOrderParams, pipeline: ExecutionPipeline, venue: BinanceVenueAdapter, policy: BinancePolicy, action: "entry" | "adjustment"): Promise<BinanceOrderResult>;
//# sourceMappingURL=binance-order-helpers.d.ts.map
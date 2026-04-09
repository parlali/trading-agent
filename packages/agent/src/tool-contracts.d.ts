import { type VenueApp } from "@valiq-trading/core";
import { z } from "zod";
import type { ToolCategory, ToolDefinition } from "./tool-registry";
export type ToolContractBoundary = "shared" | "venue-owned";
export interface ToolContractVariant {
    description: string;
    parameters: z.ZodTypeAny;
    jsonSchema: Record<string, unknown>;
    outputDescription: string;
    errorSemantics: string;
}
export interface ToolContractDefinition {
    name: string;
    category: ToolCategory;
    boundary: ToolContractBoundary;
    owner: string;
    compatibleVenues: readonly VenueApp[];
    defaultVariant?: ToolContractVariant;
    variants?: Partial<Record<VenueApp, ToolContractVariant>>;
}
export interface ResolvedToolContract extends ToolContractVariant {
    name: string;
    category: ToolCategory;
    boundary: ToolContractBoundary;
    owner: string;
    compatibleVenues: readonly VenueApp[];
}
export declare const emptyParamsSchema: z.ZodObject<{}, z.core.$strip>;
export declare const orderIdParamsSchema: z.ZodObject<{
    orderId: z.ZodString;
}, z.core.$strip>;
export declare const orderIdWithReasonParamsSchema: z.ZodObject<{
    orderId: z.ZodString;
    reason: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const waitForOrderUpdateParamsSchema: z.ZodObject<{
    orderId: z.ZodString;
    timeoutMs: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const genericLegSchema: z.ZodObject<{
    instrument: z.ZodString;
    side: z.ZodEnum<{
        buy: "buy";
        sell: "sell";
    }>;
    quantity: z.ZodNumber;
    limitPrice: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const alpacaLegSchema: z.ZodObject<{
    instrument: z.ZodString;
    side: z.ZodEnum<{
        buy_to_open: "buy_to_open";
        sell_to_open: "sell_to_open";
    }>;
    quantity: z.ZodNumber;
}, z.core.$strip>;
export declare const genericOrderParamsSchema: z.ZodObject<{
    instrument: z.ZodString;
    side: z.ZodEnum<{
        buy: "buy";
        sell: "sell";
    }>;
    quantity: z.ZodNumber;
    orderType: z.ZodEnum<{
        market: "market";
        limit: "limit";
        stop: "stop";
        stop_limit: "stop_limit";
    }>;
    limitPrice: z.ZodOptional<z.ZodNumber>;
    stopPrice: z.ZodOptional<z.ZodNumber>;
    timeInForce: z.ZodDefault<z.ZodEnum<{
        day: "day";
        gtc: "gtc";
        ioc: "ioc";
        fok: "fok";
    }>>;
    legs: z.ZodOptional<z.ZodArray<z.ZodObject<{
        instrument: z.ZodString;
        side: z.ZodEnum<{
            buy: "buy";
            sell: "sell";
        }>;
        quantity: z.ZodNumber;
        limitPrice: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
export declare const genericOrderJsonSchema: {
    type: string;
    properties: {
        instrument: {
            type: string;
            description: string;
        };
        side: {
            type: string;
            enum: string[];
        };
        quantity: {
            type: string;
            description: string;
        };
        orderType: {
            type: string;
            enum: string[];
        };
        limitPrice: {
            type: string;
            description: string;
        };
        stopPrice: {
            type: string;
            description: string;
        };
        timeInForce: {
            type: string;
            enum: string[];
            default: string;
        };
        legs: {
            type: string;
            description: string;
            items: {
                type: string;
                properties: {
                    instrument: {
                        type: string;
                    };
                    side: {
                        type: string;
                        enum: string[];
                    };
                    quantity: {
                        type: string;
                    };
                    limitPrice: {
                        type: string;
                    };
                };
                required: string[];
            };
        };
        metadata: {
            type: string;
            description: string;
        };
    };
    required: string[];
};
export declare const alpacaOrderParamsSchema: z.ZodObject<{
    instrument: z.ZodString;
    side: z.ZodLiteral<"sell">;
    quantity: z.ZodNumber;
    orderType: z.ZodLiteral<"limit">;
    limitPrice: z.ZodNumber;
    timeInForce: z.ZodDefault<z.ZodLiteral<"day">>;
    legs: z.ZodArray<z.ZodObject<{
        instrument: z.ZodString;
        side: z.ZodEnum<{
            buy_to_open: "buy_to_open";
            sell_to_open: "sell_to_open";
        }>;
        quantity: z.ZodNumber;
    }, z.core.$strip>>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
export declare const alpacaOrderJsonSchema: {
    type: string;
    properties: {
        instrument: {
            type: string;
            description: string;
        };
        side: {
            type: string;
            enum: string[];
            description: string;
        };
        quantity: {
            type: string;
            description: string;
        };
        orderType: {
            type: string;
            enum: string[];
            description: string;
        };
        limitPrice: {
            type: string;
            description: string;
        };
        timeInForce: {
            type: string;
            enum: string[];
            default: string;
        };
        legs: {
            type: string;
            minItems: number;
            maxItems: number;
            description: string;
            items: {
                type: string;
                properties: {
                    instrument: {
                        type: string;
                        description: string;
                    };
                    side: {
                        type: string;
                        enum: string[];
                    };
                    quantity: {
                        type: string;
                        description: string;
                    };
                };
                required: string[];
            };
        };
        metadata: {
            type: string;
            description: string;
        };
    };
    required: string[];
};
export declare const genericAdjustmentParamsSchema: z.ZodObject<{
    instrument: z.ZodString;
    side: z.ZodEnum<{
        buy: "buy";
        sell: "sell";
    }>;
    quantity: z.ZodNumber;
    orderType: z.ZodEnum<{
        market: "market";
        limit: "limit";
        stop: "stop";
        stop_limit: "stop_limit";
    }>;
    limitPrice: z.ZodOptional<z.ZodNumber>;
    stopPrice: z.ZodOptional<z.ZodNumber>;
    timeInForce: z.ZodDefault<z.ZodEnum<{
        day: "day";
        gtc: "gtc";
        ioc: "ioc";
        fok: "fok";
    }>>;
    reason: z.ZodString;
}, z.core.$strip>;
export declare const genericAdjustmentJsonSchema: {
    type: string;
    properties: {
        instrument: {
            type: string;
            description: string;
        };
        side: {
            type: string;
            enum: string[];
            description: string;
        };
        quantity: {
            type: string;
            description: string;
        };
        orderType: {
            type: string;
            enum: string[];
        };
        limitPrice: {
            type: string;
        };
        stopPrice: {
            type: string;
        };
        timeInForce: {
            type: string;
            enum: string[];
            default: string;
        };
        reason: {
            type: string;
            description: string;
        };
    };
    required: string[];
};
export declare const binanceAdjustmentParamsSchema: z.ZodObject<{
    instrument: z.ZodString;
    stopLoss: z.ZodOptional<z.ZodNumber>;
    takeProfit: z.ZodOptional<z.ZodNumber>;
    reason: z.ZodString;
}, z.core.$strip>;
export declare const binanceAdjustmentJsonSchema: {
    type: string;
    properties: {
        instrument: {
            type: string;
            description: string;
        };
        stopLoss: {
            type: string;
            description: string;
        };
        takeProfit: {
            type: string;
            description: string;
        };
        reason: {
            type: string;
            description: string;
        };
    };
    required: string[];
};
export declare const closeParamsSchema: z.ZodObject<{
    instrument: z.ZodString;
    reason: z.ZodString;
}, z.core.$strip>;
export declare const closeJsonSchema: {
    type: string;
    properties: {
        instrument: {
            type: string;
            description: string;
        };
        reason: {
            type: string;
            description: string;
        };
    };
    required: string[];
};
export declare const defaultModifyOrderParamsSchema: z.ZodObject<{
    orderId: z.ZodString;
    limitPrice: z.ZodOptional<z.ZodNumber>;
    stopPrice: z.ZodOptional<z.ZodNumber>;
    quantity: z.ZodOptional<z.ZodNumber>;
    reason: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const defaultModifyOrderJsonSchema: {
    type: string;
    properties: {
        orderId: {
            type: string;
            description: string;
        };
        limitPrice: {
            type: string;
            description: string;
        };
        stopPrice: {
            type: string;
            description: string;
        };
        quantity: {
            type: string;
            description: string;
        };
        reason: {
            type: string;
            description: string;
        };
    };
    required: string[];
};
export declare const alpacaModifyOrderParamsSchema: z.ZodObject<{
    orderId: z.ZodString;
    limitPrice: z.ZodOptional<z.ZodNumber>;
    quantity: z.ZodOptional<z.ZodNumber>;
    reason: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const alpacaModifyOrderJsonSchema: {
    type: string;
    properties: {
        orderId: {
            type: string;
            description: string;
        };
        limitPrice: {
            type: string;
            description: string;
        };
        quantity: {
            type: string;
            description: string;
        };
        reason: {
            type: string;
            description: string;
        };
    };
    required: string[];
};
export declare const mt5ModifyOrderParamsSchema: z.ZodObject<{
    orderId: z.ZodNumber;
    newStopLoss: z.ZodOptional<z.ZodNumber>;
    newTakeProfit: z.ZodOptional<z.ZodNumber>;
    reason: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const mt5ModifyOrderJsonSchema: {
    type: string;
    properties: {
        orderId: {
            type: string;
            description: string;
        };
        newStopLoss: {
            type: string;
            description: string;
        };
        newTakeProfit: {
            type: string;
            description: string;
        };
        reason: {
            type: string;
            description: string;
        };
    };
    required: string[];
    anyOf: {
        required: string[];
    }[];
};
export declare const getOptionsChainParamsSchema: z.ZodObject<{
    underlyingSymbol: z.ZodString;
    expirationDate: z.ZodOptional<z.ZodString>;
    expirationDateFrom: z.ZodOptional<z.ZodString>;
    expirationDateTo: z.ZodOptional<z.ZodString>;
    strikePriceGte: z.ZodOptional<z.ZodNumber>;
    strikePriceLte: z.ZodOptional<z.ZodNumber>;
    optionType: z.ZodOptional<z.ZodEnum<{
        call: "call";
        put: "put";
    }>>;
    limit: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const getOptionsChainJsonSchema: {
    type: string;
    properties: {
        underlyingSymbol: {
            type: string;
            description: string;
        };
        expirationDate: {
            type: string;
            description: string;
        };
        expirationDateFrom: {
            type: string;
            description: string;
        };
        expirationDateTo: {
            type: string;
            description: string;
        };
        strikePriceGte: {
            type: string;
            description: string;
        };
        strikePriceLte: {
            type: string;
            description: string;
        };
        optionType: {
            type: string;
            enum: string[];
        };
        limit: {
            type: string;
            description: string;
        };
    };
    required: string[];
};
export declare const singleSymbolParamsSchema: z.ZodObject<{
    symbol: z.ZodString;
}, z.core.$strip>;
export declare const getQuoteJsonSchema: {
    type: string;
    properties: {
        symbol: {
            type: string;
            description: string;
        };
    };
    required: string[];
};
export declare const getSymbolInfoJsonSchema: {
    type: string;
    properties: {
        symbol: {
            type: string;
            description: string;
        };
    };
    required: string[];
};
export declare const polymarketMarketPriceParamsSchema: z.ZodObject<{
    tokenId: z.ZodString;
    side: z.ZodOptional<z.ZodEnum<{
        buy: "buy";
        sell: "sell";
    }>>;
}, z.core.$strip>;
export declare const polymarketMarketPriceJsonSchema: {
    type: string;
    properties: {
        tokenId: {
            type: string;
            description: string;
        };
        side: {
            type: string;
            enum: string[];
            description: string;
        };
    };
    required: string[];
};
export declare const binanceMarketPriceJsonSchema: {
    type: string;
    properties: {
        symbol: {
            type: string;
            description: string;
        };
    };
    required: string[];
};
export declare const polymarketOrderBookParamsSchema: z.ZodObject<{
    tokenId: z.ZodString;
    levels: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const polymarketOrderBookJsonSchema: {
    type: string;
    properties: {
        tokenId: {
            type: string;
            description: string;
        };
        levels: {
            type: string;
            description: string;
        };
    };
    required: string[];
};
export declare const binanceOrderBookParamsSchema: z.ZodObject<{
    symbol: z.ZodString;
    limit: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const binanceOrderBookJsonSchema: {
    type: string;
    properties: {
        symbol: {
            type: string;
            description: string;
        };
        limit: {
            type: string;
            description: string;
        };
    };
    required: string[];
};
export declare const searchMarketsParamsSchema: z.ZodObject<{
    query: z.ZodOptional<z.ZodString>;
    conditionId: z.ZodOptional<z.ZodString>;
    limit: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const searchMarketsJsonSchema: {
    type: string;
    properties: {
        query: {
            type: string;
            description: string;
        };
        conditionId: {
            type: string;
            description: string;
        };
        limit: {
            type: string;
            description: string;
        };
    };
};
export declare const webSearchParamsSchema: z.ZodObject<{
    query: z.ZodString;
    maxResults: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export declare const webSearchJsonSchema: {
    type: string;
    properties: {
        query: {
            type: string;
            description: string;
        };
        maxResults: {
            type: string;
            description: string;
        };
    };
    required: string[];
};
export declare const webFetchParamsSchema: z.ZodObject<{
    url: z.ZodString;
    maxLength: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export declare const webFetchJsonSchema: {
    type: string;
    properties: {
        url: {
            type: string;
            description: string;
        };
        maxLength: {
            type: string;
            description: string;
        };
    };
    required: string[];
};
export declare function createToolContractCatalog(contracts: readonly ToolContractDefinition[]): Map<string, ToolContractDefinition>;
export declare function getToolContract(name: string, venue?: VenueApp): ResolvedToolContract;
export declare function getToolCategory(name: string): ToolCategory;
export declare function getToolBoundary(name: string): ToolContractBoundary;
export declare function listToolContracts(): ResolvedToolContract[];
export declare function createToolDefinition(config: {
    name: string;
    venue?: VenueApp;
    handler: ToolDefinition["handler"];
}): ToolDefinition;
//# sourceMappingURL=tool-contracts.d.ts.map
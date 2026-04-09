import { VENUE_APPS } from "@valiq-trading/core";
import { z } from "zod";
import { binanceOrderJsonSchema, binanceOrderParamsSchema, } from "./tools/binance-order-helpers";
import { mt5OrderJsonSchema, mt5OrderParamsSchema, } from "./tools/mt5-order-helpers";
export const emptyParamsSchema = z.object({});
export const orderIdParamsSchema = z.object({
    orderId: z.string(),
});
export const orderIdWithReasonParamsSchema = z.object({
    orderId: z.string(),
    reason: z.string().optional(),
});
export const waitForOrderUpdateParamsSchema = z.object({
    orderId: z.string(),
    timeoutMs: z.number().int().positive().max(300000).optional(),
});
export const genericLegSchema = z.object({
    instrument: z.string(),
    side: z.enum(["buy", "sell"]),
    quantity: z.number().positive(),
    limitPrice: z.number().optional(),
});
export const alpacaLegSchema = z.object({
    instrument: z.string(),
    side: z.enum(["buy_to_open", "sell_to_open"]),
    quantity: z.number().int().positive(),
});
export const genericOrderParamsSchema = z.object({
    instrument: z.string(),
    side: z.enum(["buy", "sell"]),
    quantity: z.number().positive(),
    orderType: z.enum(["market", "limit", "stop", "stop_limit"]),
    limitPrice: z.number().optional(),
    stopPrice: z.number().optional(),
    timeInForce: z.enum(["day", "gtc", "ioc", "fok"]).default("day"),
    legs: z.array(genericLegSchema).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
});
export const genericOrderJsonSchema = {
    type: "object",
    properties: {
        instrument: { type: "string", description: "The instrument or ticker symbol" },
        side: { type: "string", enum: ["buy", "sell"] },
        quantity: { type: "number", description: "Number of units to trade" },
        orderType: { type: "string", enum: ["market", "limit", "stop", "stop_limit"] },
        limitPrice: { type: "number", description: "Limit price for limit or stop_limit orders" },
        stopPrice: { type: "number", description: "Stop price for stop or stop_limit orders" },
        timeInForce: { type: "string", enum: ["day", "gtc", "ioc", "fok"], default: "day" },
        legs: {
            type: "array",
            description: "Optional multi-leg order components",
            items: {
                type: "object",
                properties: {
                    instrument: { type: "string" },
                    side: { type: "string", enum: ["buy", "sell"] },
                    quantity: { type: "number" },
                    limitPrice: { type: "number" },
                },
                required: ["instrument", "side", "quantity"],
            },
        },
        metadata: { type: "object", description: "Optional metadata for deterministic processing" },
    },
    required: ["instrument", "side", "quantity", "orderType"],
};
export const alpacaOrderParamsSchema = z.object({
    instrument: z.string(),
    side: z.literal("sell"),
    quantity: z.number().int().positive(),
    orderType: z.literal("limit"),
    limitPrice: z.number().positive(),
    timeInForce: z.literal("day").default("day"),
    legs: z.array(alpacaLegSchema).length(4),
    metadata: z.record(z.string(), z.unknown()).optional(),
});
export const alpacaOrderJsonSchema = {
    type: "object",
    properties: {
        instrument: {
            type: "string",
            description: "Structure identifier in the form IC:UNDERLYING:YYYY-MM-DD:QUANTITY",
        },
        side: {
            type: "string",
            enum: ["sell"],
            description: "Iron condor entries are submitted as net-credit sells",
        },
        quantity: { type: "number", description: "Number of full iron condor structures" },
        orderType: {
            type: "string",
            enum: ["limit"],
            description: "Only net-credit limit entries are supported for this strategy path",
        },
        limitPrice: { type: "number", description: "Net credit limit price for the full 4-leg structure" },
        timeInForce: {
            type: "string",
            enum: ["day"],
            default: "day",
        },
        legs: {
            type: "array",
            minItems: 4,
            maxItems: 4,
            description: "Exactly four OCC option legs with explicit open semantics",
            items: {
                type: "object",
                properties: {
                    instrument: { type: "string", description: "OCC option symbol, e.g. SPY260410P00510000" },
                    side: {
                        type: "string",
                        enum: ["buy_to_open", "sell_to_open"],
                    },
                    quantity: { type: "number", description: "Leg ratio quantity. Use integer 1 for each leg." },
                },
                required: ["instrument", "side", "quantity"],
            },
        },
        metadata: { type: "object", description: "Optional metadata for deterministic processing" },
    },
    required: ["instrument", "side", "quantity", "orderType", "limitPrice", "timeInForce", "legs"],
};
export const genericAdjustmentParamsSchema = z.object({
    instrument: z.string(),
    side: z.enum(["buy", "sell"]),
    quantity: z.number().positive(),
    orderType: z.enum(["market", "limit", "stop", "stop_limit"]),
    limitPrice: z.number().optional(),
    stopPrice: z.number().optional(),
    timeInForce: z.enum(["day", "gtc", "ioc", "fok"]).default("day"),
    reason: z.string(),
});
export const genericAdjustmentJsonSchema = {
    type: "object",
    properties: {
        instrument: { type: "string", description: "The instrument to adjust" },
        side: { type: "string", enum: ["buy", "sell"], description: "Direction of the adjustment" },
        quantity: { type: "number", description: "Quantity to add or reduce" },
        orderType: { type: "string", enum: ["market", "limit", "stop", "stop_limit"] },
        limitPrice: { type: "number" },
        stopPrice: { type: "number" },
        timeInForce: { type: "string", enum: ["day", "gtc", "ioc", "fok"], default: "day" },
        reason: { type: "string", description: "Why this adjustment is being made" },
    },
    required: ["instrument", "side", "quantity", "orderType", "reason"],
};
export const binanceAdjustmentParamsSchema = z.object({
    instrument: z.string(),
    stopLoss: z.number().optional(),
    takeProfit: z.number().optional(),
    reason: z.string(),
});
export const binanceAdjustmentJsonSchema = {
    type: "object",
    properties: {
        instrument: { type: "string", description: "Perpetual symbol, e.g. BTCUSDT or ETHUSDT" },
        stopLoss: { type: "number", description: "New stop-loss price" },
        takeProfit: { type: "number", description: "New take-profit price" },
        reason: { type: "string", description: "Why this adjustment is needed" },
    },
    required: ["instrument", "reason"],
};
export const closeParamsSchema = z.object({
    instrument: z.string(),
    reason: z.string(),
});
export const closeJsonSchema = {
    type: "object",
    properties: {
        instrument: { type: "string", description: "The instrument to close the position for" },
        reason: { type: "string", description: "Why the position is being closed" },
    },
    required: ["instrument", "reason"],
};
export const defaultModifyOrderParamsSchema = z.object({
    orderId: z.string(),
    limitPrice: z.number().optional(),
    stopPrice: z.number().optional(),
    quantity: z.number().positive().optional(),
    reason: z.string().optional(),
});
export const defaultModifyOrderJsonSchema = {
    type: "object",
    properties: {
        orderId: { type: "string", description: "The order ID to modify" },
        limitPrice: { type: "number", description: "New limit price" },
        stopPrice: { type: "number", description: "New stop price" },
        quantity: { type: "number", description: "New quantity" },
        reason: { type: "string", description: "Why the order is being modified" },
    },
    required: ["orderId"],
};
export const alpacaModifyOrderParamsSchema = z.object({
    orderId: z.string(),
    limitPrice: z.number().positive().optional(),
    quantity: z.number().int().positive().optional(),
    reason: z.string().optional(),
});
export const alpacaModifyOrderJsonSchema = {
    type: "object",
    properties: {
        orderId: { type: "string", description: "The order ID to modify" },
        limitPrice: { type: "number", description: "New net limit price for the full structure" },
        quantity: { type: "number", description: "Optional new structure quantity" },
        reason: { type: "string", description: "Why the order is being modified" },
    },
    required: ["orderId"],
};
export const mt5ModifyOrderParamsSchema = z.object({
    orderId: z.number().int().positive(),
    newStopLoss: z.number().optional(),
    newTakeProfit: z.number().optional(),
    reason: z.string().optional(),
}).refine((value) => value.newStopLoss !== undefined || value.newTakeProfit !== undefined, {
    message: "Provide newStopLoss, newTakeProfit, or both",
    path: ["newStopLoss"],
});
export const mt5ModifyOrderJsonSchema = {
    type: "object",
    properties: {
        orderId: { type: "number", description: "Numeric MT5 order ticket to modify" },
        newStopLoss: { type: "number", description: "New absolute stop-loss price" },
        newTakeProfit: { type: "number", description: "New absolute take-profit price" },
        reason: { type: "string", description: "Why the protective levels are changing" },
    },
    required: ["orderId"],
    anyOf: [
        { required: ["newStopLoss"] },
        { required: ["newTakeProfit"] },
    ],
};
export const getOptionsChainParamsSchema = z.object({
    underlyingSymbol: z.string(),
    expirationDate: z.string().optional(),
    expirationDateFrom: z.string().optional(),
    expirationDateTo: z.string().optional(),
    strikePriceGte: z.number().optional(),
    strikePriceLte: z.number().optional(),
    optionType: z.enum(["call", "put"]).optional(),
    limit: z.number().int().positive().max(1000).optional(),
});
export const getOptionsChainJsonSchema = {
    type: "object",
    properties: {
        underlyingSymbol: {
            type: "string",
            description: "Underlying equity symbol such as SPY",
        },
        expirationDate: {
            type: "string",
            description: "Exact expiration date in YYYY-MM-DD format",
        },
        expirationDateFrom: {
            type: "string",
            description: "Earliest expiration date in YYYY-MM-DD format",
        },
        expirationDateTo: {
            type: "string",
            description: "Latest expiration date in YYYY-MM-DD format",
        },
        strikePriceGte: {
            type: "number",
            description: "Minimum strike price filter",
        },
        strikePriceLte: {
            type: "number",
            description: "Maximum strike price filter",
        },
        optionType: {
            type: "string",
            enum: ["call", "put"],
        },
        limit: {
            type: "number",
            description: "Maximum number of contracts to return",
        },
    },
    required: ["underlyingSymbol"],
};
export const singleSymbolParamsSchema = z.object({
    symbol: z.string(),
});
export const getQuoteJsonSchema = {
    type: "object",
    properties: {
        symbol: {
            type: "string",
            description: "Underlying equity symbol such as SPY",
        },
    },
    required: ["symbol"],
};
export const getSymbolInfoJsonSchema = {
    type: "object",
    properties: {
        symbol: {
            type: "string",
            description: "MT5 symbol such as XAUUSD or US30",
        },
    },
    required: ["symbol"],
};
export const polymarketMarketPriceParamsSchema = z.object({
    tokenId: z.string(),
    side: z.enum(["buy", "sell"]).optional(),
});
export const polymarketMarketPriceJsonSchema = {
    type: "object",
    properties: {
        tokenId: {
            type: "string",
            description: "Polymarket token ID",
        },
        side: {
            type: "string",
            enum: ["buy", "sell"],
            description: "Optional side to include the current executable price",
        },
    },
    required: ["tokenId"],
};
export const binanceMarketPriceJsonSchema = {
    type: "object",
    properties: {
        symbol: {
            type: "string",
            description: "Binance futures symbol such as BTCUSDT or ETHUSDT",
        },
    },
    required: ["symbol"],
};
export const polymarketOrderBookParamsSchema = z.object({
    tokenId: z.string(),
    levels: z.number().int().positive().max(50).optional(),
});
export const polymarketOrderBookJsonSchema = {
    type: "object",
    properties: {
        tokenId: {
            type: "string",
            description: "Polymarket token ID",
        },
        levels: {
            type: "number",
            description: "Optional number of bid and ask levels to return",
        },
    },
    required: ["tokenId"],
};
export const binanceOrderBookParamsSchema = z.object({
    symbol: z.string(),
    limit: z.number().int().positive().max(1000).optional(),
});
export const binanceOrderBookJsonSchema = {
    type: "object",
    properties: {
        symbol: {
            type: "string",
            description: "Binance futures symbol such as BTCUSDT or ETHUSDT",
        },
        limit: {
            type: "number",
            description: "Depth limit passed to Binance",
        },
    },
    required: ["symbol"],
};
export const searchMarketsParamsSchema = z.object({
    query: z.string().optional(),
    conditionId: z.string().optional(),
    limit: z.number().int().positive().max(25).optional(),
});
export const searchMarketsJsonSchema = {
    type: "object",
    properties: {
        query: {
            type: "string",
            description: "Search text matching the question, description, category, or outcomes",
        },
        conditionId: {
            type: "string",
            description: "Exact Polymarket condition ID",
        },
        limit: {
            type: "number",
            description: "Maximum number of markets to return",
        },
    },
};
export const webSearchParamsSchema = z.object({
    query: z.string(),
    maxResults: z.number().int().positive().max(20).default(5),
});
export const webSearchJsonSchema = {
    type: "object",
    properties: {
        query: { type: "string", description: "The search query" },
        maxResults: { type: "number", description: "Maximum number of results (1-20, default 5)" },
    },
    required: ["query"],
};
export const webFetchParamsSchema = z.object({
    url: z.string().url(),
    maxLength: z.number().int().positive().default(10000),
});
export const webFetchJsonSchema = {
    type: "object",
    properties: {
        url: { type: "string", description: "The URL to fetch" },
        maxLength: { type: "number", description: "Maximum characters to return (default 10000)" },
    },
    required: ["url"],
};
const toolContracts = createToolContractCatalog([
    {
        name: "get_positions",
        category: "account",
        boundary: "shared",
        owner: "shared",
        compatibleVenues: VENUE_APPS,
        defaultVariant: {
            description: "Get all current open positions. Returns instrument, side, quantity, entry price, current price, and unrealized P&L for each position.",
            parameters: emptyParamsSchema,
            jsonSchema: { type: "object", properties: {} },
            outputDescription: "Returns the open positions array or an empty array when nothing is open.",
            errorSemantics: "Returns current broker or dry-run state. Transport or adapter failures throw.",
        },
    },
    {
        name: "get_account",
        category: "account",
        boundary: "shared",
        owner: "shared",
        compatibleVenues: VENUE_APPS,
        defaultVariant: {
            description: "Get current account state including balance, buying power, margin usage, and P&L.",
            parameters: emptyParamsSchema,
            jsonSchema: { type: "object", properties: {} },
            outputDescription: "Returns the current normalized account snapshot.",
            errorSemantics: "Returns current broker or dry-run state. Transport or adapter failures throw.",
        },
    },
    {
        name: "get_order_status",
        category: "execution",
        boundary: "shared",
        owner: "shared",
        compatibleVenues: VENUE_APPS,
        defaultVariant: {
            description: "Check the current fill status of a tracked order. Returns the latest status, fill progress, and lifecycle snapshot.",
            parameters: orderIdParamsSchema,
            jsonSchema: {
                type: "object",
                properties: {
                    orderId: { type: "string", description: "The order ID to check" },
                },
                required: ["orderId"],
            },
            outputDescription: "Returns the normalized execution status plus any tracked order snapshot.",
            errorSemantics: "Known order lookup failures return a structured error payload instead of throwing.",
        },
    },
    {
        name: "cancel_order",
        category: "execution",
        boundary: "shared",
        owner: "shared",
        compatibleVenues: VENUE_APPS,
        defaultVariant: {
            description: "Cancel a pending unfilled order. Provide the order ID.",
            parameters: orderIdWithReasonParamsSchema,
            jsonSchema: {
                type: "object",
                properties: {
                    orderId: { type: "string", description: "The order ID to cancel" },
                    reason: { type: "string", description: "Why the order is being cancelled" },
                },
                required: ["orderId"],
            },
            outputDescription: "Returns the normalized cancellation result plus any tracked order snapshot.",
            errorSemantics: "Validation or broker rejections are returned in the execution payload.",
        },
    },
    {
        name: "wait_for_order_update",
        category: "execution",
        boundary: "shared",
        owner: "shared",
        compatibleVenues: VENUE_APPS,
        defaultVariant: {
            description: "Wait for the next order lifecycle update in the current run. Use this when an order is still pending or partially filled and you need the refreshed snapshot before deciding what to do next.",
            parameters: waitForOrderUpdateParamsSchema,
            jsonSchema: {
                type: "object",
                properties: {
                    orderId: { type: "string", description: "The tracked order ID to wait on" },
                    timeoutMs: { type: "number", description: "Optional maximum wait for this tool call in milliseconds" },
                },
                required: ["orderId"],
            },
            outputDescription: "Returns the refreshed tracked order snapshot after the next lifecycle update or timeout boundary.",
            errorSemantics: "Wait failures throw. Timeout behavior is surfaced through the returned polling state.",
        },
    },
    {
        name: "propose_order",
        category: "execution",
        boundary: "shared",
        owner: "shared",
        compatibleVenues: VENUE_APPS,
        variants: {
            "alpaca-options": {
                description: "Propose a new 4-leg iron condor entry. Use net-credit limit pricing, `day` time in force, and four OCC option legs with explicit open semantics.",
                parameters: alpacaOrderParamsSchema,
                jsonSchema: alpacaOrderJsonSchema,
                outputDescription: "Returns the normalized execution result, risk validation, and tracked order snapshot for the structure.",
                errorSemantics: "Broker or policy rejections are returned in the execution payload.",
            },
            polymarket: {
                description: "Propose a new order. The order is validated by the risk engine before execution. For multi-leg orders, provide the legs array. Returns the execution result including order ID and fill status.",
                parameters: genericOrderParamsSchema,
                jsonSchema: genericOrderJsonSchema,
                outputDescription: "Returns the normalized execution result, risk validation, and tracked order snapshot for the proposed order.",
                errorSemantics: "Broker or policy rejections are returned in the execution payload. Estimated execution pricing is injected from live venue data.",
            },
            mt5: {
                description: [
                    "Propose a new MT5 order.",
                    "You must provide stopLoss and either takeProfit or riskRewardRatio, not both.",
                    "Position size is calculated automatically so that hitting your stop-loss loses exactly maxRiskPercent of account balance.",
                    "Do not specify quantity or lot size because it is computed for you.",
                    "Returns the execution result including computed lot size, risk amount, and risk-reward ratio.",
                ].join(" "),
                parameters: mt5OrderParamsSchema,
                jsonSchema: mt5OrderJsonSchema,
                outputDescription: "Returns the normalized execution result plus computed sizing, risk, and price verification details.",
                errorSemantics: "Pre-validation failures return a structured rejected payload instead of throwing.",
            },
            "binance-futures": {
                description: [
                    "Propose a Binance futures entry order for BTCUSDT or ETHUSDT.",
                    "You must provide stopLoss and either takeProfit or riskRewardRatio.",
                    "Position size is calculated automatically from maxRiskPercent and stop distance.",
                    "Leverage defaults to policy maxLeverage and cannot exceed it.",
                    "For filled entries, protective stop-loss and take-profit orders are attached automatically.",
                ].join(" "),
                parameters: binanceOrderParamsSchema,
                jsonSchema: binanceOrderJsonSchema,
                outputDescription: "Returns the normalized execution result plus computed sizing, leverage, and protection-order details.",
                errorSemantics: "Pre-validation failures return a structured rejected payload instead of throwing.",
            },
        },
    },
    {
        name: "propose_adjustment",
        category: "execution",
        boundary: "shared",
        owner: "shared",
        compatibleVenues: VENUE_APPS,
        variants: {
            "alpaca-options": {
                description: "Propose adjusting an existing position by adding to or partially reducing it. Provide the instrument, direction, and quantity of the adjustment. Include a reason for the adjustment.",
                parameters: genericAdjustmentParamsSchema,
                jsonSchema: genericAdjustmentJsonSchema,
                outputDescription: "Returns the normalized adjustment execution result plus risk validation details.",
                errorSemantics: "Broker or policy rejections are returned in the execution payload.",
            },
            polymarket: {
                description: "Propose adjusting an existing position by adding to or partially reducing it. Provide the instrument, direction, and quantity of the adjustment. Include a reason for the adjustment.",
                parameters: genericAdjustmentParamsSchema,
                jsonSchema: genericAdjustmentJsonSchema,
                outputDescription: "Returns the normalized adjustment execution result plus risk validation details.",
                errorSemantics: "Broker or policy rejections are returned in the execution payload. Estimated execution pricing is injected from live venue data.",
            },
            mt5: {
                description: [
                    "Propose adjusting an existing MT5 position by adding to it.",
                    "You must provide stopLoss and either takeProfit or riskRewardRatio, not both.",
                    "Position size is calculated automatically so that hitting your stop-loss loses exactly maxRiskPercent of account balance.",
                    "Do not specify quantity or lot size because it is computed for you.",
                    "Include a reason for the adjustment.",
                ].join(" "),
                parameters: mt5OrderParamsSchema,
                jsonSchema: mt5OrderJsonSchema,
                outputDescription: "Returns the normalized adjustment execution result plus computed sizing and risk details.",
                errorSemantics: "Pre-validation failures return a structured rejected payload instead of throwing.",
            },
            "binance-futures": {
                description: "Update protective stop-loss and take-profit orders for an existing Binance futures position.",
                parameters: binanceAdjustmentParamsSchema,
                jsonSchema: binanceAdjustmentJsonSchema,
                outputDescription: "Returns the protection-order update result including cancelled and recreated protection order IDs.",
                errorSemantics: "Missing protection levels or missing positions return a structured rejected payload instead of throwing.",
            },
        },
    },
    {
        name: "propose_close",
        category: "execution",
        boundary: "shared",
        owner: "shared",
        compatibleVenues: VENUE_APPS,
        defaultVariant: {
            description: "Propose closing an entire position for a given instrument. Provide the instrument and a reason for closing.",
            parameters: closeParamsSchema,
            jsonSchema: closeJsonSchema,
            outputDescription: "Returns the normalized close execution result plus risk validation details.",
            errorSemantics: "Broker or policy rejections are returned in the execution payload.",
        },
    },
    {
        name: "modify_order",
        category: "execution",
        boundary: "shared",
        owner: "shared",
        compatibleVenues: ["alpaca-options", "polymarket", "mt5"],
        variants: {
            "alpaca-options": {
                description: "Modify a working Alpaca iron condor order. Supported changes are the net limit price and, if truly necessary, the structure quantity.",
                parameters: alpacaModifyOrderParamsSchema,
                jsonSchema: alpacaModifyOrderJsonSchema,
                outputDescription: "Returns the normalized order modification result plus the refreshed tracked order snapshot.",
                errorSemantics: "Broker rejections are returned in the execution payload.",
            },
            polymarket: {
                description: "Modify a pending order. You can change the limit price, stop price, or quantity. At least one modification field must be provided.",
                parameters: defaultModifyOrderParamsSchema,
                jsonSchema: defaultModifyOrderJsonSchema,
                outputDescription: "Returns the normalized order modification result plus the refreshed tracked order snapshot.",
                errorSemantics: "Broker rejections are returned in the execution payload.",
            },
            mt5: {
                description: "Adjust stop-loss and or take-profit on an existing MT5 position using its numeric order ticket. Quantity and entry price changes are not supported.",
                parameters: mt5ModifyOrderParamsSchema,
                jsonSchema: mt5ModifyOrderJsonSchema,
                outputDescription: "Returns the normalized order modification result plus the refreshed tracked order snapshot.",
                errorSemantics: "Missing protective fields fail schema validation before execution. Broker rejections are returned in the execution payload.",
            },
        },
    },
    {
        name: "get_options_chain",
        category: "market-data",
        boundary: "venue-owned",
        owner: "alpaca-options",
        compatibleVenues: ["alpaca-options"],
        defaultVariant: {
            description: "Fetch the live Alpaca options chain for an underlying. Returns contracts with current bid and ask, midpoint, latest trade, greeks, implied volatility, and open interest from Alpaca market data.",
            parameters: getOptionsChainParamsSchema,
            jsonSchema: getOptionsChainJsonSchema,
            outputDescription: "Returns normalized options contracts and any pagination token from Alpaca.",
            errorSemantics: "Venue lookup failures throw.",
        },
    },
    {
        name: "get_quote",
        category: "market-data",
        boundary: "venue-owned",
        owner: "alpaca-options",
        compatibleVenues: ["alpaca-options"],
        defaultVariant: {
            description: "Fetch the latest live Alpaca quote for an equity underlying. Returns current bid, ask, last trade price, minute bar, and timestamps.",
            parameters: singleSymbolParamsSchema,
            jsonSchema: getQuoteJsonSchema,
            outputDescription: "Returns the current normalized equity quote and recent bar snapshot.",
            errorSemantics: "Venue lookup failures throw.",
        },
    },
    {
        name: "get_symbol_info",
        category: "market-data",
        boundary: "venue-owned",
        owner: "mt5",
        compatibleVenues: ["mt5"],
        defaultVariant: {
            description: "Fetch live MT5 symbol information including bid, ask, spread, tick value, contract size, and volume constraints.",
            parameters: singleSymbolParamsSchema,
            jsonSchema: getSymbolInfoJsonSchema,
            outputDescription: "Returns normalized MT5 symbol metadata or a found:false payload when the symbol is unavailable.",
            errorSemantics: "Missing symbols return found:false. Worker or transport failures throw.",
        },
    },
    {
        name: "get_market_price",
        category: "market-data",
        boundary: "venue-owned",
        owner: "venue-extension",
        compatibleVenues: ["polymarket", "binance-futures"],
        variants: {
            polymarket: {
                description: "Fetch the current Polymarket midpoint, best bid, best ask, spread, and optional executable price for a token.",
                parameters: polymarketMarketPriceParamsSchema,
                jsonSchema: polymarketMarketPriceJsonSchema,
                outputDescription: "Returns normalized Polymarket pricing and spread information for the requested token.",
                errorSemantics: "Venue lookup failures throw.",
            },
            "binance-futures": {
                description: "Fetch the current Binance futures mark price, index price, best bid, best ask, spread, funding rate, and next funding time for a symbol.",
                parameters: singleSymbolParamsSchema,
                jsonSchema: binanceMarketPriceJsonSchema,
                outputDescription: "Returns normalized Binance futures pricing, spread, and funding information for the requested symbol.",
                errorSemantics: "Venue lookup failures throw.",
            },
        },
    },
    {
        name: "get_order_book",
        category: "market-data",
        boundary: "venue-owned",
        owner: "venue-extension",
        compatibleVenues: ["polymarket", "binance-futures"],
        variants: {
            polymarket: {
                description: "Fetch the live Polymarket order book for a token. Use this to assess spread and available depth before sizing an order.",
                parameters: polymarketOrderBookParamsSchema,
                jsonSchema: polymarketOrderBookJsonSchema,
                outputDescription: "Returns normalized Polymarket order book depth for the requested token.",
                errorSemantics: "Venue lookup failures throw.",
            },
            "binance-futures": {
                description: "Fetch the live Binance futures order book for a symbol. Use this to assess depth and likely slippage before sizing larger entries.",
                parameters: binanceOrderBookParamsSchema,
                jsonSchema: binanceOrderBookJsonSchema,
                outputDescription: "Returns normalized Binance futures order book depth for the requested symbol.",
                errorSemantics: "Venue lookup failures throw.",
            },
        },
    },
    {
        name: "search_markets",
        category: "market-data",
        boundary: "venue-owned",
        owner: "polymarket",
        compatibleVenues: ["polymarket"],
        defaultVariant: {
            description: "Search active Polymarket markets by query or fetch a specific market by condition ID. Returns market metadata plus current token pricing and basic liquidity indicators.",
            parameters: searchMarketsParamsSchema,
            jsonSchema: searchMarketsJsonSchema,
            outputDescription: "Returns normalized Polymarket market search results.",
            errorSemantics: "Invalid empty requests throw before venue lookup.",
        },
    },
    {
        name: "web_search",
        category: "web",
        boundary: "venue-owned",
        owner: "polymarket",
        compatibleVenues: ["polymarket"],
        defaultVariant: {
            description: "Search the internet for information. Returns a list of results with title, URL, and snippet. Useful for market news, event research, and finding current information.",
            parameters: webSearchParamsSchema,
            jsonSchema: webSearchJsonSchema,
            outputDescription: "Returns normalized web search results.",
            errorSemantics: "Provider failures throw unless the provider itself returns a degraded result.",
        },
    },
    {
        name: "web_fetch",
        category: "web",
        boundary: "venue-owned",
        owner: "polymarket",
        compatibleVenues: ["polymarket"],
        defaultVariant: {
            description: "Fetch the content of a specific URL and return it as text. HTML tags are stripped. Content is truncated to maxLength characters.",
            parameters: webFetchParamsSchema,
            jsonSchema: webFetchJsonSchema,
            outputDescription: "Returns fetched content, truncated content length, or a structured fetch error payload.",
            errorSemantics: "HTTP and fetch failures are returned as payload errors instead of throwing where possible.",
        },
    },
]);
export function createToolContractCatalog(contracts) {
    const catalog = new Map();
    for (const contract of contracts) {
        if (catalog.has(contract.name)) {
            throw new Error(`Duplicate tool contract definition detected for ${contract.name}`);
        }
        const variantVenues = Object.keys(contract.variants ?? {});
        for (const venue of variantVenues) {
            if (!contract.compatibleVenues.includes(venue)) {
                throw new Error(`Tool contract ${contract.name} defines unsupported venue variant ${venue}`);
            }
        }
        if (!contract.defaultVariant) {
            for (const venue of contract.compatibleVenues) {
                if (!contract.variants?.[venue]) {
                    throw new Error(`Tool contract ${contract.name} is missing a variant for ${venue}`);
                }
            }
        }
        catalog.set(contract.name, contract);
    }
    return catalog;
}
export function getToolContract(name, venue) {
    const contract = toolContracts.get(name);
    if (!contract) {
        throw new Error(`Unknown tool contract: ${name}`);
    }
    if (venue && !contract.compatibleVenues.includes(venue)) {
        throw new Error(`Tool ${name} is not compatible with venue ${venue}`);
    }
    const variant = venue
        ? contract.variants?.[venue] ?? contract.defaultVariant
        : contract.defaultVariant ?? firstVariant(contract);
    if (!variant) {
        throw new Error(`Tool contract ${name} has no resolvable variant`);
    }
    return {
        name: contract.name,
        category: contract.category,
        boundary: contract.boundary,
        owner: contract.owner,
        compatibleVenues: contract.compatibleVenues,
        description: variant.description,
        parameters: variant.parameters,
        jsonSchema: variant.jsonSchema,
        outputDescription: variant.outputDescription,
        errorSemantics: variant.errorSemantics,
    };
}
export function getToolCategory(name) {
    return getToolContract(name).category;
}
export function getToolBoundary(name) {
    return getToolContract(name).boundary;
}
export function listToolContracts() {
    return Array.from(toolContracts.keys()).map((name) => getToolContract(name));
}
export function createToolDefinition(config) {
    const contract = getToolContract(config.name, config.venue);
    return {
        name: contract.name,
        description: contract.description,
        parameters: contract.parameters,
        jsonSchema: contract.jsonSchema,
        category: contract.category,
        compatibleVenues: contract.compatibleVenues,
        contractBoundary: contract.boundary,
        contractOwner: contract.owner,
        outputDescription: contract.outputDescription,
        errorSemantics: contract.errorSemantics,
        handler: config.handler,
    };
}
function firstVariant(contract) {
    if (!contract.variants) {
        return undefined;
    }
    for (const venue of contract.compatibleVenues) {
        const variant = contract.variants[venue];
        if (variant) {
            return variant;
        }
    }
    return undefined;
}

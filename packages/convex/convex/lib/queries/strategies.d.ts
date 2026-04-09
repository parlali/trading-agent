export declare const getStrategyConfigs: import("convex/server").RegisteredQuery<"public", {
    app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures";
    serviceToken: string;
}, Promise<{
    _id: import("convex/values").GenericId<"strategies">;
    _creationTime: number;
    app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures";
    name: string;
    enabled: boolean;
    schedule: string;
    policy: any;
    context: string;
    createdAt: number;
    updatedAt: number;
}[]>>;
export declare const getStrategyById: import("convex/server").RegisteredQuery<"public", {
    serviceToken?: string | undefined;
    id: import("convex/values").GenericId<"strategies">;
}, Promise<{
    _id: import("convex/values").GenericId<"strategies">;
    _creationTime: number;
    app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures";
    name: string;
    enabled: boolean;
    schedule: string;
    policy: any;
    context: string;
    createdAt: number;
    updatedAt: number;
} | null>>;
export declare const getAllStrategies: import("convex/server").RegisteredQuery<"public", {
    serviceToken?: string | undefined;
}, Promise<{
    _id: import("convex/values").GenericId<"strategies">;
    _creationTime: number;
    app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures";
    name: string;
    enabled: boolean;
    schedule: string;
    policy: any;
    context: string;
    createdAt: number;
    updatedAt: number;
}[]>>;
export declare const getStrategyOwnedInstruments: import("convex/server").RegisteredQuery<"public", {
    strategyId: import("convex/values").GenericId<"strategies">;
    serviceToken: string;
}, Promise<string[]>>;
export declare const getAllOwnedInstrumentsByApp: import("convex/server").RegisteredQuery<"public", {
    app: "alpaca-options" | "polymarket" | "mt5" | "binance-futures";
    serviceToken: string;
}, Promise<{
    instrument: string;
    strategyId: import("../../_generated/dataModel").Id<"strategies">;
}[]>>;
//# sourceMappingURL=strategies.d.ts.map
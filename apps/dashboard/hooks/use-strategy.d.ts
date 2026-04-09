export declare function useStrategy(id: string): {
    data: {
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
    } | null | undefined;
    isLoading: boolean;
    notFound: boolean;
};
//# sourceMappingURL=use-strategy.d.ts.map
type StepResult = {
    name: string;
    ok: boolean;
    data?: unknown;
    error?: string;
};
export declare const testBackendHealth: import("convex/server").RegisteredAction<"public", {}, Promise<{
    ok: boolean;
    error: string;
    steps: never[];
} | {
    ok: boolean;
    steps: {
        name: string;
        ok: boolean;
        error: string | undefined;
    }[];
    error?: undefined;
} | {
    ok: boolean;
    steps: {
        name: string;
        ok: boolean;
        data: unknown;
    }[];
    error?: undefined;
}>>;
export declare const testMT5Connection: import("convex/server").RegisteredAction<"public", {}, Promise<{
    ok: boolean;
    steps: StepResult[];
}>>;
export declare const testAlpacaConnection: import("convex/server").RegisteredAction<"public", {}, Promise<{
    ok: boolean;
    steps: StepResult[];
}>>;
export declare const testPolymarketConnection: import("convex/server").RegisteredAction<"public", {}, Promise<{
    ok: boolean;
    steps: StepResult[];
}>>;
export declare const testBinanceConnection: import("convex/server").RegisteredAction<"public", {}, Promise<{
    ok: boolean;
    steps: StepResult[];
}>>;
export declare const testValiqConnection: import("convex/server").RegisteredAction<"public", {
    prompt: string;
}, Promise<{
    ok: boolean;
    error: string;
    steps: never[];
} | {
    ok: boolean;
    steps: StepResult[];
    error?: undefined;
}>>;
export {};
//# sourceMappingURL=connectionTests.d.ts.map
export type TimeRange = "24h" | "7d" | "30d" | "90d" | "all";
export declare const TIME_RANGES: {
    value: TimeRange;
    label: string;
}[];
export declare function EquityChart({ data, timeRange, height, }: {
    data: Record<string, number>[];
    timeRange: TimeRange;
    height?: number;
}): import("react").JSX.Element;
//# sourceMappingURL=equity-chart.d.ts.map
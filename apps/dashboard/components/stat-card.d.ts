import type { ReactNode } from "react";
type StatFormat = "currency" | "pnl" | "custom";
export declare function StatCard({ label, value, format, size, children, className, }: {
    label: string;
    value?: number;
    format?: StatFormat;
    size?: "lg" | "xl" | "2xl";
    children?: ReactNode;
    className?: string;
}): import("react").JSX.Element;
export {};
//# sourceMappingURL=stat-card.d.ts.map
import type { ReactNode } from "react";
export type Column<T> = {
    key: string;
    header: string;
    align?: "left" | "right" | "center";
    headerClassName?: string;
    cellClassName?: string;
    render: (item: T) => ReactNode;
};
export declare function DataTable<T>({ columns, data, getRowKey, className, }: {
    columns: Column<T>[];
    data: T[];
    getRowKey: (item: T) => string;
    className?: string;
}): import("react").JSX.Element;
//# sourceMappingURL=data-table.d.ts.map
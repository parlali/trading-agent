import type { ReactNode } from "react";
export declare function CardList<T>({ data, getKey, renderCard, className, }: {
    data: T[];
    getKey: (item: T) => string;
    renderCard: (item: T) => ReactNode;
    className?: string;
}): import("react").JSX.Element;
//# sourceMappingURL=card-list.d.ts.map
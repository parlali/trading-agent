type FilterVariant = "pills" | "tabs";
export declare function FilterBar<T extends string | null>({ items, selected, onSelect, getLabel, variant, }: {
    items: readonly T[];
    selected: T;
    onSelect: (value: T) => void;
    getLabel: (value: T) => string;
    variant?: FilterVariant;
}): import("react").JSX.Element;
export {};
//# sourceMappingURL=filter-bar.d.ts.map